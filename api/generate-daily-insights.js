// Vercel Cron Job: runs daily at 4:00am UTC (with 6:00 and 8:00 gap-fill runs).
// Fetches today's aliyah texts from Sefaria, generates insights via Gemini in
// small batches, and stores them in Upstash KV — one key per book:chapter:verse.

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
// request; whatever is left over is picked up by the next cron's gap-fill.
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
      console.log(`[generate-daily-insights] ${label}: ${validated.length}/${records.length} verses with gems`);
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
      if (Date.now() >= deadline) break;   // leave the rest to the next cron
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
 * Write one batch's gems. setnx so the first good result wins and a later cron
 * only fills holes; empty results are never written, so a verse with no gems
 * stays retryable rather than being locked in as empty.
 */
async function persistEntries(redis, entries) {
  const withPearls = entries.filter(e => e.pearls.length);
  if (withPearls.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const { ref, pearls } of withPearls) pipeline.setnx(refToKvKey(ref), pearls);
  await pipeline.exec();
  return withPearls.length;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const start = Date.now();
  const { weekday, year, month, day } = getJerusalemParts();
  const dateKey  = `${year}-${month}-${day}`;
  const dayMap   = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const dayOfWeek = dayMap[weekday];

  console.log(`[generate-daily-insights] start — date=${dateKey} weekday=${weekday}`);

  if (dayOfWeek === 6) {
    console.log(`[generate-daily-insights] Shabbat — skipping`);
    return res.json({ message: 'Shabbat — skipped', date: dateKey });
  }

  // Fetch parasha calendar from Sefaria
  console.log(`[generate-daily-insights] fetching Sefaria calendar...`);
  const t1 = Date.now();
  const calRes = await fetch('https://www.sefaria.org/api/calendars?diaspora=0');
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
  const redis    = Redis.fromEnv();
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
