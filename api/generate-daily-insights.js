// Generates insights for a given day's aliyah on demand, via the "צור פנינים"
// button — there is no cron anymore. Fetches that day's aliyah texts from
// Sefaria, generates insights via Gemini in small batches, and stores them in
// Upstash KV — one key per book:chapter:verse.

import { Redis } from '@upstash/redis';
import {
  getAliyahRefsForDay,
  getJerusalemParts,
  fetchAliyahTexts,
  fetchCommentaries,
  refToKvKey,
} from './_sefaria.js';
import {
  BATCH_SIZE,
  MAX_CONCURRENT,
  MODEL,
  SYSTEM_PROMPT,
  INSIGHTS_SCHEMA,
  buildVerseRecords,
  buildBatchPrompt,
  chunk,
  validateBatchResponse,
} from './_insights.js';

export const config = {
  maxDuration: 60,
};

// ─── Gemini ───────────────────────────────────────────────────────────────────

const GEMINI_TIMEOUT_MS = 25000;
// The function's maxDuration is 60s. Stop starting Gemini work at 48s so there
// is always room to finish the in-flight batch's KV write and answer the
// request; whatever is left over is picked up by the next manual run's gap-fill.
const BATCH_DEADLINE_MS = 48000;
// Not worth starting an attempt that cannot plausibly finish.
const MIN_ATTEMPT_MS = 5000;

function isRetryable(status) {
  return status === 429 || status >= 500;
}

/**
 * One Gemini call for one batch of verses. Returns
 * { ok, entries } — ok:false means the call itself failed, which is distinct
 * from a batch that succeeded but found no gems. A single bad batch must not
 * sink the whole day, so failures are reported, never thrown.
 */
async function generateBatch(records, batchNum, totalBatches, deadline) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const label      = `batch ${batchNum}/${totalBatches}`;
  const userPrompt = buildBatchPrompt(records);
  console.log(`[generate-daily-insights] ${label}: ${records.length} verses, ${userPrompt.length} chars (${records[0].ref}…${records[records.length - 1].ref})`);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      console.warn(`[generate-daily-insights] ${label}: ${remaining}ms left before deadline — not attempting`);
      return { ok: false, entries: [] };
    }

    const t = Date.now();
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(Math.min(GEMINI_TIMEOUT_MS, remaining)),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: INSIGHTS_SCHEMA,
            },
          }),
        }
      );

      if (!response.ok) {
        const body = await response.text();
        console.error(`[generate-daily-insights] ${label} attempt ${attempt}: HTTP ${response.status} after ${Date.now() - t}ms — ${body.slice(0, 300)}`);
        if (attempt === 1 && isRetryable(response.status)) continue;
        return { ok: false, entries: [] };
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      console.log(`[generate-daily-insights] ${label} responded (${Date.now() - t}ms)`);
      if (!text) return { ok: true, entries: [] };

      const validated = validateBatchResponse(JSON.parse(text), records);
      const withGems  = validated.filter(e => e.pearls.length).length;
      console.log(`[generate-daily-insights] ${label}: ${withGems}/${records.length} verses with gems`);
      return { ok: true, entries: validated };

    } catch (err) {
      console.error(`[generate-daily-insights] ${label} attempt ${attempt} failed after ${Date.now() - t}ms:`, err.message);
      if (attempt === 1) continue;
      return { ok: false, entries: [] };
    }
  }

  return { ok: false, entries: [] };
}

/**
 * Run the batches through a bounded worker pool so a long parasha can't fire
 * a dozen simultaneous Gemini calls.
 *
 * Each batch is persisted the moment it completes rather than after the whole
 * pool settles: one slow batch (up to two 25s attempts) can otherwise run the
 * invocation past maxDuration and take every already-finished batch down with
 * it, which is exactly the all-or-nothing failure this change exists to remove.
 */
async function runBatches(records, deadline, persist) {
  const batches = chunk(records, BATCH_SIZE);
  const results = new Array(batches.length);
  let next = 0;
  let saved = 0;

  const worker = async () => {
    while (next < batches.length) {
      if (Date.now() >= deadline) break;   // leave the rest to the next manual run
      const i = next++;
      const result = await generateBatch(batches[i], i + 1, batches.length, deadline);
      results[i] = result;
      if (result.entries.length) {
        // Read-modify-write of `saved` must happen after the await, not around
        // it — `saved += await …` would let concurrent workers clobber it.
        const written = await persist(result.entries);
        saved += written;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, batches.length) }, worker)
  );

  const done           = results.filter(Boolean);
  const failedBatches  = done.filter(r => !r.ok).length;
  const skippedBatches = batches.length - done.length;
  return { batchCount: batches.length, failedBatches, skippedBatches, saved };
}

/**
 * Write every verse in the batch, gems or not. setnx so the first result
 * wins. A verse the model legitimately found nothing on is still written as
 * an empty array — it's "attempted", which is what lets the client tell
 * "generated, no gems" apart from "never generated" and only offer a retry
 * for the latter. Returns the count that actually had gems, for logging.
 */
async function persistEntries(redis, entries) {
  if (entries.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const { ref, pearls } of entries) pipeline.setnx(refToKvKey(ref), pearls);
  await pipeline.exec();
  return entries.filter(e => e.pearls.length).length;
}

// ─── Manual (retry-button) guards ─────────────────────────────────────────────

// A manual run spends Gemini quota, so it is bounded two ways: one run at a
// time per target date, and a per-real-day ceiling across ALL target dates.
// The quota is keyed to the caller's actual current day (server-computed,
// never from the request), not the requested date — otherwise an
// unauthenticated caller could get 10 fresh attempts just by requesting a
// different date each time. Neither guard applies to the cron, which
// authenticates with CRON_SECRET. Gap-filling means a manual run costs
// nothing once a date is complete — it makes zero Gemini calls and returns
// "already generated".
const MANUAL_RUNS_PER_DAY = 10;
const LOCK_TTL_SECONDS    = 120;
const MANUAL_COUNTER_TTL  = 172800;   // 48h — long enough to outlive the day

async function claimManualRun(redis, dateKey, quotaKey) {
  const countKey = `manual:${quotaKey}`;
  const count = await redis.incr(countKey);
  if (count === 1) await redis.expire(countKey, MANUAL_COUNTER_TTL);
  if (count > MANUAL_RUNS_PER_DAY) {
    return { ok: false, status: 429, error: 'daily limit reached' };
  }

  const lockKey = `lock:generate:${dateKey}`;
  const locked = await redis.set(lockKey, '1', { nx: true, ex: LOCK_TTL_SECONDS });
  if (locked !== 'OK') {
    return { ok: false, status: 409, error: 'already running' };
  }

  return { ok: true, lockKey };
}

// The button sends the Gregorian date (Jerusalem calendar day) it's currently
// showing, so generation targets whatever day the user is looking at instead
// of always assuming today. Omitted (or unparseable) falls back to today.
function parseDateParam(req) {
  try {
    const url   = new URL(req.url, 'https://mikra.local');
    const year  = Number(url.searchParams.get('year'));
    const month = Number(url.searchParams.get('month'));
    const day   = Number(url.searchParams.get('day'));
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  } catch {
    return null;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const start = Date.now();
  const cronSecret = process.env.CRON_SECRET;
  // Cron mode requires the secret. Anything else is a manual run from the
  // retry button and goes through the rate guards below. When CRON_SECRET is
  // unset every request is treated as manual, so the endpoint is never
  // unguarded.
  const isCron = !!cronSecret && req.headers['authorization'] === `Bearer ${cronSecret}`;

  if (!isCron && req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const explicitDate = isCron ? null : parseDateParam(req);
  const { weekday, year, month, day } = getJerusalemParts(explicitDate);
  const dateKey  = `${year}-${month}-${day}`;
  const dayMap   = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const dayOfWeek = dayMap[weekday];

  console.log(`[generate-daily-insights] start — date=${dateKey} weekday=${weekday} mode=${isCron ? 'cron' : 'manual'}`);

  if (dayOfWeek === 6) {
    console.log(`[generate-daily-insights] Shabbat — skipping`);
    return res.json({ message: 'Shabbat — skipped', date: dateKey });
  }

  const redis = Redis.fromEnv();

  // Claimed before any Gemini work, released in the finally below.
  let lockKey = null;
  if (!isCron) {
    // Caller-independent: the real current day, never the requested one.
    const today     = getJerusalemParts();
    const quotaKey  = `${today.year}-${today.month}-${today.day}`;
    const claim = await claimManualRun(redis, dateKey, quotaKey);
    if (!claim.ok) {
      console.log(`[generate-daily-insights] manual run refused — ${claim.error}`);
      return res.status(claim.status).json({ error: claim.error, date: dateKey });
    }
    lockKey = claim.lockKey;
  }

  try {
    return await generate({ req, res, redis, start, dateKey, dayOfWeek, explicitDate });
  } finally {
    if (lockKey) await redis.del(lockKey).catch(() => {});
  }
}

async function generate({ res, redis, start, dateKey, dayOfWeek, explicitDate }) {
  // Fetch parasha calendar from Sefaria
  console.log(`[generate-daily-insights] fetching Sefaria calendar...`);
  const t1 = Date.now();
  const calParams = new URLSearchParams({ diaspora: '0' });
  if (explicitDate) {
    calParams.set('year', String(explicitDate.year));
    calParams.set('month', String(explicitDate.month));
    calParams.set('day', String(explicitDate.day));
  }
  const calRes = await fetch(`https://www.sefaria.org/api/calendars?${calParams.toString()}`);
  if (!calRes.ok) {
    console.error(`[generate-daily-insights] calendar fetch failed — HTTP ${calRes.status}`);
    return res.status(502).json({ error: 'Sefaria calendar fetch failed' });
  }
  const calendar = await calRes.json();
  console.log(`[generate-daily-insights] calendar fetched (${Date.now() - t1}ms)`);

  const parashat = (calendar.calendar_items || []).find(i => i.title?.en === 'Parashat Hashavua');
  if (!parashat) {
    return res.status(404).json({ error: 'Parashat Hashavua not found in calendar' });
  }

  const aliyot     = parashat.extraDetails?.aliyot || [];
  const aliyahRefs = getAliyahRefsForDay(dayOfWeek, aliyot);

  if (aliyahRefs.length === 0) {
    return res.status(404).json({ error: 'No aliyah refs found', dayOfWeek });
  }

  console.log(`[generate-daily-insights] parasha=${parashat.displayValue?.en} refs=${aliyahRefs.join(', ')}`);

  // Fetch mikra texts + commentaries in parallel
  console.log(`[generate-daily-insights] fetching mikra + commentaries from Sefaria...`);
  const t2 = Date.now();
  const [mikraResults, commentariesArray] = await Promise.all([
    Promise.all(aliyahRefs.map(fetchAliyahTexts)),
    Promise.all(aliyahRefs.map(fetchCommentaries)),
  ]);
  console.log(`[generate-daily-insights] Sefaria fetches done (${Date.now() - t2}ms)`);

  const mikraArrays = mikraResults.map(r => r.verses);
  const verseRefs   = mikraResults.flatMap(r => r.verseRefs);
  const torahVerses = mikraArrays.flat();

  // Flatten commentaries aligned to torahVerses
  const combined = { rashi: [], ramban: [], haamekDavar: [], ravHirsch: [] };
  mikraArrays.forEach((mikraVerses, aliyahPos) => {
    const c = commentariesArray[aliyahPos] || {};
    for (let v = 0; v < mikraVerses.length; v++) {
      combined.rashi.push(c.rashi?.[v] || []);
      combined.ramban.push(c.ramban?.[v] || []);
      combined.haamekDavar.push(c.haamekDavar?.[v] || []);
      combined.ravHirsch.push(c.ravHirsch?.[v] || []);
    }
  });

  console.log(`[generate-daily-insights] ${torahVerses.length} verses, ${verseRefs.length} refs`);

  if (verseRefs.filter(Boolean).length === 0) {
    console.error(`[generate-daily-insights] verseRefs empty — Sefaria returned no usable verse data`);
    return res.status(500).json({ error: 'verseRefs empty — cannot store insights by verse', aliyahRefs });
  }

  const allRecords = buildVerseRecords(verseRefs, torahVerses, combined);

  // Gap-fill: only generate for verses that aren't already in KV. This is what
  // lets the 6:00 and 8:00 crons finish what a timed-out 4:00 run started.
  const existing = allRecords.length
    ? await redis.mget(...allRecords.map(r => refToKvKey(r.ref)))
    : [];
  const records = allRecords.filter((_, i) => existing[i] == null);

  console.log(`[generate-daily-insights] ${allRecords.length} verses with commentary, ${records.length} missing from KV`);

  if (records.length === 0) {
    console.log(`[generate-daily-insights] all verses already generated — skipping`);
    return res.json({ message: 'already generated', date: dateKey, refs: aliyahRefs });
  }

  const { batchCount, failedBatches, skippedBatches, saved } = await runBatches(
    records,
    start + BATCH_DEADLINE_MS,
    (entries) => persistEntries(redis, entries),
  );

  console.log(`[generate-daily-insights] done — batches=${batchCount} failed=${failedBatches} skipped=${skippedBatches} saved=${saved} total=${Date.now() - start}ms`);

  return res.json({
    success: true,
    date: dateKey,
    refs: aliyahRefs,
    attempted: records.length,
    batches: batchCount,
    failedBatches,
    skippedBatches,
    saved,
  });
}
