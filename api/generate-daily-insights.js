// Vercel Cron Job: runs daily at 4am UTC (= 6am Jerusalem Standard Time).
// Fetches today's aliyah, generates insights via Gemini, saves to Vercel Blob.

import { put } from '@vercel/blob';

export const config = {
  maxDuration: 300,
};

const BASE_URL = 'https://www.sefaria.org';

// Day-of-week → aliyah index (mirrors app.js)
const DAY_TO_ALIYAH = {
  0: 0,       // Sunday    → 1st aliyah
  1: 1,       // Monday    → 2nd aliyah
  2: 2,       // Tuesday   → 3rd aliyah
  3: 3,       // Wednesday → 4th aliyah
  4: 4,       // Thursday  → 5th aliyah
  5: [5, 6],  // Friday    → 6th & 7th aliyot
  6: null,    // Saturday  → Shabbat, skip
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

// ─── Sefaria helpers ──────────────────────────────────────────────────────────

function convertRefFormat(ref) {
  return ref
    .replace(/ (\d)/g, '.$1')
    .replace(/:/g, '.');
}

async function fetchText(ref) {
  try {
    const res = await fetch(`${BASE_URL}/api/v3/texts/${encodeURIComponent(ref)}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function selectVersion(data, preferredTitles) {
  const versions = data?.versions;
  if (!versions || versions.length === 0) return null;
  for (const title of preferredTitles) {
    const found = versions.find(v => v.versionTitle === title);
    if (found) return found;
  }
  return versions[0];
}

function flattenVerses(text) {
  if (!text) return [];
  if (typeof text === 'string') return [text.trim()].filter(Boolean);
  if (text.every(v => typeof v === 'string')) return text.map(v => v.trim()).filter(Boolean);
  return text.flatMap(chapter => {
    if (typeof chapter === 'string') return [chapter.trim()].filter(Boolean);
    return chapter.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  });
}

function flattenCommentaryVerses(text) {
  if (!text) return [];
  if (typeof text === 'string') return [[text.trim()]].filter(Boolean);
  if (text.every(v => typeof v === 'string')) return text.map(v => [v.trim()].filter(Boolean));
  return text.flatMap(chapter => {
    if (typeof chapter === 'string') return [[chapter.trim()]].filter(Boolean);
    return chapter.map(v => {
      if (Array.isArray(v)) return v.filter(Boolean).map(c => c.trim());
      if (typeof v === 'string') return [v.trim()];
      return [];
    });
  });
}

async function fetchAliyahTexts(ref) {
  const mikraRef      = convertRefFormat(ref);
  const steinsaltzRef = `Steinsaltz_on_${convertRefFormat(ref)}`;

  const [mikraData] = await Promise.all([fetchText(mikraRef)]);
  const mikraVersion = selectVersion(mikraData, ['Miqra according to the Masorah', "Tanach with Ta'amei Hamikra"]);
  return flattenVerses(mikraVersion?.text ?? null);
}

async function fetchCommentaries(ref) {
  const [rashiData, rambanData, haamekDavarData, ravHirschData] = await Promise.all([
    fetchText(`Rashi_on_${convertRefFormat(ref)}`),
    fetchText(`Ramban_on_${convertRefFormat(ref)}`),
    fetchText(`Haamek_Davar_on_${convertRefFormat(ref)}`),
    fetchText(`Rav Hirsch on Torah, ${ref}`),
  ]);

  const rashiVersion       = rashiData?.versions?.find(v => v.language === 'he' && v.isPrimary) ?? rashiData?.versions?.[0];
  const rambanVersion      = rambanData?.versions?.find(v => v.language === 'he' && v.isPrimary) ?? rambanData?.versions?.[0];
  const haamekDavarVersion = haamekDavarData?.versions?.find(v => v.language === 'he') ?? haamekDavarData?.versions?.[0];
  const ravHirschVersion   = ravHirschData?.versions?.[0];

  return {
    rashi:       rashiVersion?.text       ?? null,
    ramban:      rambanVersion?.text      ?? null,
    haamekDavar: haamekDavarVersion?.text ?? null,
    ravHirsch:   ravHirschVersion?.text   ?? null,
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
    const rashi      = (commentaries.rashi?.[idx]      || []).join(' | ');
    const ramban     = (commentaries.ramban?.[idx]     || []).join(' | ');
    const haamekDavar = (commentaries.haamekDavar?.[idx] || []).join(' | ');
    const ravHirsch  = (commentaries.ravHirsch?.[idx]  || []).join(' | ');
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
  // Verify Vercel cron authorization
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Determine today's date + weekday in Jerusalem timezone
  const { weekday, year, month, day } = getJerusalemParts();
  const dateKey = `${year}-${month}-${day}`;
  const dayMap  = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const dayOfWeek = dayMap[weekday];

  // Skip Shabbat
  if (dayOfWeek === 6) {
    return Response.json({ message: 'Shabbat — skipped', date: dateKey });
  }

  // Fetch current parasha from Sefaria
  const calRes = await fetch(`${BASE_URL}/api/calendars`);
  if (!calRes.ok) {
    return Response.json({ error: 'Sefaria calendar fetch failed' }, { status: 502 });
  }
  const calendar = await calRes.json();
  const parashat = (calendar.calendar_items || []).find(i => i.title?.en === 'Parashat Hashavua');
  if (!parashat) {
    return Response.json({ error: 'Parashat Hashavua not found in calendar' }, { status: 404 });
  }

  const aliyot     = parashat.extraDetails?.aliyot || [];
  const aliyahIndex = DAY_TO_ALIYAH[dayOfWeek];
  const indices     = Array.isArray(aliyahIndex) ? aliyahIndex : [aliyahIndex];
  const aliyahRefs  = indices.map(i => aliyot[i]).filter(Boolean);

  if (aliyahRefs.length === 0) {
    return Response.json({ error: 'No aliyah refs found', dayOfWeek, aliyot }, { status: 404 });
  }

  // Fetch mikra texts + commentaries in parallel across aliyot
  const [mikraArrays, commentariesArray] = await Promise.all([
    Promise.all(aliyahRefs.map(fetchAliyahTexts)),
    Promise.all(aliyahRefs.map(fetchCommentaries)),
  ]);

  const torahVerses = mikraArrays.flat();

  // Merge commentaries across aliyot (same logic as old loadInsights)
  const flatCommentaries = commentariesArray.map(c => ({
    rashi:       flattenCommentaryVerses(c.rashi),
    ramban:      flattenCommentaryVerses(c.ramban),
    haamekDavar: flattenCommentaryVerses(c.haamekDavar),
    ravHirsch:   flattenCommentaryVerses(c.ravHirsch),
  }));

  const combined = { rashi: [], ramban: [], haamekDavar: [], ravHirsch: [] };
  for (const c of flatCommentaries) {
    const verseCount = c.rashi.length;
    for (let v = 0; v < verseCount; v++) {
      combined.rashi.push(c.rashi[v] || []);
      combined.ramban.push(c.ramban[v] || []);
      combined.haamekDavar.push(c.haamekDavar[v] || []);
      combined.ravHirsch.push(c.ravHirsch[v] || []);
    }
  }

  // Generate insights via Gemini
  const insights = await generateInsights(aliyahRefs.join(', '), torahVerses, combined);

  // Save to Vercel Blob — overwrites same pathname each time (no suffix)
  await put(`insights/${dateKey}.json`, JSON.stringify(insights), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });

  return Response.json({ success: true, date: dateKey, refs: aliyahRefs });
}
