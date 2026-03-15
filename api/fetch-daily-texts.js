// Vercel Cron Job: runs daily at 4:00am UTC.
// Fetches today's aliyah texts + commentaries from Sefaria, saves to Vercel Blob.

import { put } from '@vercel/blob';

export const config = {
  maxDuration: 60,
};

const BASE_URL = 'https://www.sefaria.org';

const DAY_TO_ALIYAH = {
  0: 0,       // Sunday    → 1st aliyah
  1: 1,       // Monday    → 2nd aliyah
  2: 2,       // Tuesday   → 3rd aliyah
  3: 3,       // Wednesday → 4th aliyah
  4: 4,       // Thursday  → 5th aliyah
  5: [5, 6],  // Friday    → 6th & 7th aliyot (+ Maftir when present)
  6: null,    // Saturday  → Shabbat, skip
};



function getAliyahRefsForDay(dayOfWeek, aliyot) {
  const aliyahIndex = DAY_TO_ALIYAH[dayOfWeek];
  const indices = Array.isArray(aliyahIndex) ? [...aliyahIndex] : [aliyahIndex];

  if (dayOfWeek === 5 && aliyot?.[7]) {
    indices.push(7);
  }

  return indices.map(i => aliyot[i]).filter(Boolean);
}

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
  const t = Date.now();
  try {
    const signal = AbortSignal.timeout(15000);
    const res = await fetch(`${BASE_URL}/api/v3/texts/${encodeURIComponent(ref)}`, { signal });
    if (!res.ok) {
      console.warn(`[fetch-daily-texts] fetchText ${ref} — HTTP ${res.status} (${Date.now() - t}ms)`);
      return null;
    }
    const data = await res.json();
    console.log(`[fetch-daily-texts] fetchText ${ref} — OK (${Date.now() - t}ms)`);
    return data;
  } catch (err) {
    console.error(`[fetch-daily-texts] fetchText ${ref} — ERROR after ${Date.now() - t}ms:`, err.message);
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
  const mikraRef = convertRefFormat(ref);
  const mikraData = await fetchText(mikraRef);
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

  console.log(`[fetch-daily-texts] start — date=${dateKey} weekday=${weekday}`);

  if (dayOfWeek === 6) {
    console.log(`[fetch-daily-texts] Shabbat — skipping`);
    return res.json({ message: 'Shabbat — skipped', date: dateKey });
  }

  // Fetch current parasha from Sefaria
  console.log(`[fetch-daily-texts] fetching Sefaria calendar...`);
  const t1 = Date.now();
  const calRes = await fetch(`${BASE_URL}/api/calendars`);
  if (!calRes.ok) {
    console.error(`[fetch-daily-texts] calendar fetch failed — HTTP ${calRes.status}`);
    return res.status(502).json({ error: 'Sefaria calendar fetch failed' });
  }
  const calendar = await calRes.json();
  console.log(`[fetch-daily-texts] calendar fetched (${Date.now() - t1}ms)`);

  const parashat = (calendar.calendar_items || []).find(i => i.title?.en === 'Parashat Hashavua');
  if (!parashat) {
    console.error(`[fetch-daily-texts] Parashat Hashavua not found in calendar`);
    return res.status(404).json({ error: 'Parashat Hashavua not found in calendar' });
  }

  const aliyot    = parashat.extraDetails?.aliyot || [];
  const aliyahRefs = getAliyahRefsForDay(dayOfWeek, aliyot);

  console.log(`[fetch-daily-texts] parasha=${parashat.displayValue?.en} refs=${aliyahRefs.join(', ')}`);

  if (aliyahRefs.length === 0) {
    console.error(`[fetch-daily-texts] no aliyah refs found — dayOfWeek=${dayOfWeek} aliyot=${JSON.stringify(aliyot)}`);
    return res.status(404).json({ error: 'No aliyah refs found', dayOfWeek, aliyot });
  }

  // Fetch mikra texts + commentaries in parallel
  console.log(`[fetch-daily-texts] fetching mikra + commentaries in parallel...`);
  const t2 = Date.now();
  const [mikraArrays, commentariesArray] = await Promise.all([
    Promise.all(aliyahRefs.map(fetchAliyahTexts)),
    Promise.all(aliyahRefs.map(fetchCommentaries)),
  ]);
  console.log(`[fetch-daily-texts] all Sefaria fetches done (${Date.now() - t2}ms)`);

  const torahVerses = mikraArrays.flat();
  console.log(`[fetch-daily-texts] torahVerses=${torahVerses.length} verses`);

  const flatCommentaries = commentariesArray.map(c => ({
    rashi:       flattenCommentaryVerses(c.rashi),
    ramban:      flattenCommentaryVerses(c.ramban),
    haamekDavar: flattenCommentaryVerses(c.haamekDavar),
    ravHirsch:   flattenCommentaryVerses(c.ravHirsch),
  }));

  const combined = { rashi: [], ramban: [], haamekDavar: [], ravHirsch: [] };
  mikraArrays.forEach((mikraVerses, aliyahPos) => {
    const c = flatCommentaries[aliyahPos] || {};
    const verseCount = mikraVerses.length;
    for (let v = 0; v < verseCount; v++) {
      combined.rashi.push(c.rashi?.[v] || []);
      combined.ramban.push(c.ramban?.[v] || []);
      combined.haamekDavar.push(c.haamekDavar?.[v] || []);
      combined.ravHirsch.push(c.ravHirsch?.[v] || []);
    }
  });

  console.log(`[fetch-daily-texts] aligned commentary arrays to torah verses (${torahVerses.length} entries)`);

  console.log(`[fetch-daily-texts] saving texts blob...`);
  const t3 = Date.now();
  await put(`texts/${dateKey}.json`, JSON.stringify({ refs: aliyahRefs, torahVerses, commentaries: combined }), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  console.log(`[fetch-daily-texts] blob saved (${Date.now() - t3}ms) — total=${Date.now() - start}ms`);

  return res.json({ success: true, date: dateKey, refs: aliyahRefs });
}
