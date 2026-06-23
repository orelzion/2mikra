// GET /api/daily-insights
// Returns pre-generated insights for a date (Jerusalem date by default).
// Reads verseRefs from KV date index, then batch-fetches verse insights.
// Falls back to on-demand generation when KV has no data for today.

import { Redis } from '@upstash/redis';
import {
  refToKvKey,
  getJerusalemParts,
  getAliyahRefsForDay,
  fetchAliyahTexts,
  fetchCommentaries,
} from './_sefaria.js';

export const config = {
  maxDuration: 60,
};

function getJerusalemDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
  }).format(new Date());
}

function resolveDateKey(req) {
  try {
    const url = new URL(req.url, 'https://mikra.local');
    const requested = url.searchParams.get('date') || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(requested)) return requested;
  } catch {}
  return getJerusalemDateKey();
}

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

async function generateAndCache(redis, dateKey, dayOfWeek) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const calRes = await fetch('https://www.sefaria.org/api/calendars?diaspora=0');
  if (!calRes.ok) return null;
  const calendar = await calRes.json();

  const parashat = (calendar.calendar_items || []).find(i => i.title?.en === 'Parashat Hashavua');
  if (!parashat) return null;

  const aliyot = parashat.extraDetails?.aliyot || [];
  const aliyahRefs = getAliyahRefsForDay(dayOfWeek, aliyot);
  if (aliyahRefs.length === 0) return null;

  const [mikraResults, commentariesArray] = await Promise.all([
    Promise.all(aliyahRefs.map(fetchAliyahTexts)),
    Promise.all(aliyahRefs.map(fetchCommentaries)),
  ]);

  const mikraArrays = mikraResults.map(r => r.verses);
  const verseRefs   = mikraResults.flatMap(r => r.verseRefs);
  const torahVerses = mikraArrays.flat();

  if (verseRefs.length === 0) return null;

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

  const commentaryText = torahVerses.map((verse, idx) => {
    const rashi       = (combined.rashi?.[idx]       || []).join(' | ');
    const ramban      = (combined.ramban?.[idx]      || []).join(' | ');
    const haamekDavar = (combined.haamekDavar?.[idx] || []).join(' | ');
    const ravHirsch   = (combined.ravHirsch?.[idx]   || []).join(' | ');
    return `Verse ${idx}: ${verse}\nRashi: ${rashi}\nRamban: ${ramban}\nHa'amek Davar: ${haamekDavar}\nRav Hirsch: ${ravHirsch}`;
  }).join('\n\n');

  const userPrompt = `Here are the verses and commentaries for ${aliyahRefs.join(', ')}:\n\n${commentaryText}\n\nExtract the פנינים and return JSON.`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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

  if (!geminiRes.ok) return null;

  const geminiData = await geminiRes.json();
  const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const insightsByIndex = parsed.insights || {};
  if (Object.keys(insightsByIndex).length === 0) return null;

  const pipeline = redis.pipeline();
  for (const [idxStr, verseInsights] of Object.entries(insightsByIndex)) {
    const verseRef = verseRefs[parseInt(idxStr, 10)];
    if (!verseRef) continue;
    pipeline.setnx(refToKvKey(verseRef), verseInsights);
  }
  pipeline.set(`date:${dateKey}`, verseRefs);
  await pipeline.exec();

  const result = {};
  for (const [idxStr, verseInsights] of Object.entries(insightsByIndex)) {
    if (verseInsights && verseInsights.length > 0) result[idxStr] = verseInsights;
  }
  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const dateKey = resolveDateKey(req);
  const redis = Redis.fromEnv();

  const verseRefs = await redis.get(`date:${dateKey}`);
  if (verseRefs && verseRefs.length > 0) {
    const kvKeys = verseRefs.map(refToKvKey);
    const values = await redis.mget(...kvKeys);

    const insightsObj = {};
    values.forEach((val, idx) => {
      if (val != null) insightsObj[String(idx)] = val;
    });

    if (Object.keys(insightsObj).length > 0) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({ insights: insightsObj });
    }
  }

  // KV empty — generate on demand for today only
  const todayKey = getJerusalemDateKey();
  if (dateKey === todayKey) {
    const { weekday } = getJerusalemParts();
    const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
    const dayOfWeek = dayMap[weekday];

    if (dayOfWeek !== 6) {
      try {
        const freshInsights = await generateAndCache(redis, dateKey, dayOfWeek);
        if (freshInsights && Object.keys(freshInsights).length > 0) {
          res.setHeader('Content-Type', 'application/json');
          return res.status(200).json({ insights: freshInsights });
        }
      } catch (err) {
        console.error('[daily-insights] on-demand generation failed:', err.message);
      }
    }
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ insights: {} });
}
