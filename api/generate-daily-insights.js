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
  console.log(`[generate-daily-insights] Gemini prompt size: ${userPrompt.length} chars`);

  const t = Date.now();
  console.log(`[generate-daily-insights] calling Gemini...`);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
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

async function readJsonFromBlobUrlWithRetry(url, { attempts = 3, timeoutMs = 15000, label = 'blob-url' } = {}) {
  let lastStatus = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const start = Date.now();
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, { signal, cache: 'no-store' });

      if (res.ok) {
        return await res.json();
      }

      lastStatus = res.status;
      if (res.status >= 500 && attempt < attempts) {
        const delayMs = 250 * attempt;
        console.warn(`[generate-daily-insights] ${label} read attempt ${attempt}/${attempts} failed — HTTP ${res.status} (${Date.now() - start}ms), retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      return { __errorStatus: res.status };
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const delayMs = 250 * attempt;
        console.warn(`[generate-daily-insights] ${label} read attempt ${attempt}/${attempts} errored (${Date.now() - start}ms): ${err.message}; retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  return { __errorStatus: lastStatus || 503 };
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

  // Read texts saved by fetch-daily-texts
  const blobPath = `texts/${dateKey}.json`;
  console.log(`[generate-daily-insights] looking up ${blobPath} in Blob...`);
  const { blobs } = await list({ prefix: blobPath });
  const exactBlob = blobs.find((blob) => blob.pathname === blobPath);

  if (!exactBlob) {
    console.error(`[generate-daily-insights] texts blob not found for ${dateKey}`);
    return res.status(404).json({ error: `${blobPath} not found in Blob — run fetch-daily-texts first` });
  }

  const t1 = Date.now();
  let textsPayload;
  let primaryStatus = 0;

  try {
    textsPayload = await readJsonFromBlobUrlWithRetry(exactBlob.url, { label: 'blob.url' });
  } catch (err) {
    console.warn(`[generate-daily-insights] failed reading via blob.url — ${err.message}; trying downloadUrl`);
  }

  if (!textsPayload || textsPayload.__errorStatus) {
    primaryStatus = textsPayload?.__errorStatus || 0;

    try {
      textsPayload = await readJsonFromBlobUrlWithRetry(exactBlob.downloadUrl, { label: 'blob.downloadUrl' });
    } catch (err) {
      console.error(`[generate-daily-insights] failed to read texts blob — ERROR: ${err.message}`);
      return res.status(502).json({ error: 'Failed to read texts blob', details: err.message, primaryStatus });
    }
  }

  if (textsPayload.__errorStatus) {
    console.error(`[generate-daily-insights] failed to read texts blob — HTTP url=${primaryStatus || 'n/a'} downloadUrl=${textsPayload.__errorStatus}`);
    return res.status(502).json({
      error: 'Failed to read texts blob',
      blobStatus: { url: primaryStatus || null, downloadUrl: textsPayload.__errorStatus },
    });
  }

  const { refs, torahVerses, commentaries } = textsPayload;
  console.log(`[generate-daily-insights] texts blob read (${Date.now() - t1}ms) — ${torahVerses.length} verses, refs=${refs.join(', ')}`);

  // Generate insights via Gemini
  const insights = await generateInsights(refs.join(', '), torahVerses, commentaries);

  console.log(`[generate-daily-insights] saving insights blob...`);
  const t2 = Date.now();
  await put(`insights/${dateKey}.json`, JSON.stringify(insights), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  console.log(`[generate-daily-insights] blob saved (${Date.now() - t2}ms) — total=${Date.now() - start}ms`);

  return res.json({ success: true, date: dateKey, refs });
}
