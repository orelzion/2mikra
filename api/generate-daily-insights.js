// Vercel Cron Job: runs daily at 4:10am UTC.
// Reads today's aliyah texts from Vercel Blob, generates insights via Gemini, saves result.

import { list } from '@vercel/blob';
import { put } from '@vercel/blob';

export const config = {
  maxDuration: 60,
};

// ─── Jerusalem date helpers ───────────────────────────────────────────────────

function getJerusalemParts() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return {
    weekday: parts.find(p => p.type === 'weekday').value,
    year:    parts.find(p => p.type === 'year').value,
    month:   parts.find(p => p.type === 'month').value,
    day:     parts.find(p => p.type === 'day').value,
  };
}

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
    throw new Error(`Gemini error: ${JSON.stringify(err)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { insights: {} };
  return JSON.parse(text);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { weekday, year, month, day } = getJerusalemParts();
  const dateKey  = `${year}-${month}-${day}`;
  const dayMap   = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const dayOfWeek = dayMap[weekday];

  if (dayOfWeek === 6) {
    return Response.json({ message: 'Shabbat — skipped', date: dateKey });
  }

  // Read texts saved by fetch-daily-texts
  const { blobs } = await list({ prefix: `texts/${dateKey}.json` });
  if (blobs.length === 0) {
    return Response.json({ error: `texts/${dateKey}.json not found in Blob — run fetch-daily-texts first` }, { status: 404 });
  }

  const textsRes = await fetch(blobs[0].url);
  if (!textsRes.ok) {
    return Response.json({ error: 'Failed to read texts blob' }, { status: 502 });
  }
  const { refs, torahVerses, commentaries } = await textsRes.json();

  // Generate insights via Gemini
  const insights = await generateInsights(refs.join(', '), torahVerses, commentaries);

  await put(`insights/${dateKey}.json`, JSON.stringify(insights), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });

  return Response.json({ success: true, date: dateKey, refs });
}
