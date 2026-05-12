// Shared Sefaria fetch helpers used by generate-daily-insights.

const BASE_URL = 'https://www.sefaria.org';

export const DAY_TO_ALIYAH = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: [5, 6],
  6: null,
};

export function getAliyahRefsForDay(dayOfWeek, aliyot) {
  const aliyahIndex = DAY_TO_ALIYAH[dayOfWeek];
  const indices = Array.isArray(aliyahIndex) ? [...aliyahIndex] : [aliyahIndex];

  if (dayOfWeek === 5 && aliyot?.[7]) {
    indices.push(7);
  }

  return indices.map(i => aliyot[i]).filter(Boolean);
}

export function getJerusalemParts() {
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

export function convertRefFormat(ref) {
  return ref
    .replace(/ (\d)/g, '.$1')
    .replace(/:/g, '.');
}

export async function fetchText(ref, label = '') {
  const t = Date.now();
  try {
    const signal = AbortSignal.timeout(15000);
    const res = await fetch(`${BASE_URL}/api/v3/texts/${encodeURIComponent(ref)}`, { signal });
    if (!res.ok) {
      console.warn(`[sefaria] fetchText ${ref} — HTTP ${res.status} (${Date.now() - t}ms)`);
      return null;
    }
    const data = await res.json();
    console.log(`[sefaria] fetchText ${ref}${label ? ' ' + label : ''} — OK (${Date.now() - t}ms)`);
    return data;
  } catch (err) {
    console.error(`[sefaria] fetchText ${ref} — ERROR after ${Date.now() - t}ms:`, err.message);
    return null;
  }
}

export function selectVersion(data, preferredTitles) {
  const versions = data?.versions;
  if (!versions || versions.length === 0) return null;
  for (const title of preferredTitles) {
    const found = versions.find(v => v.versionTitle === title);
    if (found) return found;
  }
  return versions[0];
}

export function flattenVerses(text) {
  if (!text) return [];
  if (typeof text === 'string') return [text.trim()].filter(Boolean);
  if (text.every(v => typeof v === 'string')) return text.map(v => v.trim()).filter(Boolean);
  return text.flatMap(chapter => {
    if (typeof chapter === 'string') return [chapter.trim()].filter(Boolean);
    return chapter.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  });
}

export function flattenCommentaryVerses(text) {
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

export function deriveVerseRefs(data, text) {
  const book = data?.indexTitle;
  const sections = data?.sections;
  if (!book || !sections || sections.length < 2 || !text) return [];

  const startChapter = sections[0];
  const startVerse = sections[1];
  const refs = [];

  if (typeof text === 'string') {
    refs.push(`${book} ${startChapter}:${startVerse}`);
  } else if (text.every(v => typeof v === 'string')) {
    text.forEach((_, i) => refs.push(`${book} ${startChapter}:${startVerse + i}`));
  } else {
    text.forEach((chapter, chIdx) => {
      const chapterNum = startChapter + chIdx;
      const verseStart = chIdx === 0 ? startVerse : 1;
      const verses = Array.isArray(chapter) ? chapter : (chapter ? [chapter] : []);
      verses.forEach((_, vIdx) => refs.push(`${book} ${chapterNum}:${verseStart + vIdx}`));
    });
  }

  return refs;
}

export async function fetchAliyahTexts(ref) {
  const mikraRef = convertRefFormat(ref);
  const mikraData = await fetchText(mikraRef);
  const mikraVersion = selectVersion(mikraData, ['Miqra according to the Masorah', "Tanach with Ta'amei Hamikra"]);
  const text = mikraVersion?.text ?? null;
  return {
    verses: flattenVerses(text),
    verseRefs: deriveVerseRefs(mikraData, text),
  };
}

export async function fetchCommentaries(ref) {
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
    rashi:       flattenCommentaryVerses(rashiVersion?.text       ?? null),
    ramban:      flattenCommentaryVerses(rambanVersion?.text      ?? null),
    haamekDavar: flattenCommentaryVerses(haamekDavarVersion?.text ?? null),
    ravHirsch:   flattenCommentaryVerses(ravHirschVersion?.text   ?? null),
  };
}

export function refToKvKey(ref) {
  // "Genesis 1:1" → "insights:Genesis:1:1"
  const spaceIdx = ref.lastIndexOf(' ');
  const book = ref.slice(0, spaceIdx);
  const [chapter, verse] = ref.slice(spaceIdx + 1).split(':');
  return `insights:${book}:${chapter}:${verse}`;
}
