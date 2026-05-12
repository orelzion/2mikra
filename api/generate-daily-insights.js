// Vercel Cron Job: runs daily at 4:00am UTC.
// Fetches today's aliyah texts from Sefaria, generates insights via Gemini,
// and stores them in Upstash KV — one key per verse.

import { Redis } from '@upstash/redis';
import {
  DAY_TO_ALIYAH,
  getAliyahRefsForDay,
  getJerusalemParts,
  fetchAliyahTexts,
  fetchCommentaries,
  refToKvKey,
} from './_sefaria.js';

export const config = {
  maxDuration: 60,
};

// ─── Gemini ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Torah scholar with deep expertise in classical Jewish commentary.

You will receive:
1. Torah verse texts for an aliyah section
2. Raw commentary text from 4 commentators: Rashi, Ramban, Ha'amek Davar (Netziv), Rav Hirsch (in German)

Your task: Extract only the "פנינים" — the gems — from these commentaries.
Output language: Hebrew only. All insights must be in Hebrew.
Keep each insight concise: 2-3 sentences maximum.

Return a JSON object with key "insights" containing an object where:
- keys are 0-indexed verse numbers (as strings)
- values are arrays of {commentator, insight} objects.`;

async function generateInsights(ref, torahVerses, commentaries) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const commentaryText = torahVerses.map((verse, idx) => {
    const rashi       = (commentaries.rashi?.[idx]       || []).join(' | ');
    const ramban      = (commentaries.ramban?.[idx]      || []).join(' | ');
    const haamekDavar = (commentaries.haamekDavar?.[idx] || []).join(' | ');
    const ravHirsch   = (commentaries.ravHirsch?.[idx]   || []).join(' | ');
    return `Verse ${idx}: ${verse}\nRashi: ${rashi}\nRamban: ${ramban}\nHa'amek Davar: ${haamekDavar}\nRav Hirsch: ${ravHirsch}`;
  }).join('\n\n');

  const userPrompt = `Here are the verses and commentaries for ${ref}:\n\n${commentaryText}\n\nExtract the פנינים and return JSON.`;
  console.log(`[generate-daily-insights] Gemini prompt size: ${userPrompt.length} chars`);

  const t = Date.now();
  console.log(`[generate-daily-insights] calling Gemini...`);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.json();
    console.error(`[generate-daily-insights] Gemini error after ${Date.now() - t}ms:`, JSON.stringify(err));
    throw new Error(`Gemini error: ${JSON.stringify(err)}`);
  }

  const data = await response.json();
  console.log(`[generate-daily-insights] Gemini responded (${Date.now() - t}ms)`);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { insights: {} };
  return JSON.parse(text);
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
  const calRes = await fetch('https://www.sefaria.org/api/calendars');
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

  // Generate insights via Gemini
  const insights = await generateInsights(aliyahRefs.join(', '), torahVerses, combined);
  const insightsByIndex = insights.insights || {};

  // Store in KV: one key per verse + date→verseRefs index
  const redis = Redis.fromEnv();
  const pipeline = redis.pipeline();
  let savedCount = 0;

  for (const [idxStr, verseInsights] of Object.entries(insightsByIndex)) {
    const verseRef = verseRefs[parseInt(idxStr, 10)];
    if (!verseRef) continue;
    pipeline.setnx(refToKvKey(verseRef), verseInsights);
    savedCount++;
  }

  // Store date→verseRefs so daily-insights can look up KV keys by date
  pipeline.set(`date:${dateKey}`, verseRefs);

  console.log(`[generate-daily-insights] writing ${savedCount} verse insights + date index to KV...`);
  const t3 = Date.now();
  await pipeline.exec();
  console.log(`[generate-daily-insights] KV write done (${Date.now() - t3}ms) — total=${Date.now() - start}ms`);

  return res.json({ success: true, date: dateKey, refs: aliyahRefs, savedCount });
}
