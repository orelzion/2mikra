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

// Maftir (aliyot[7]) is not fetched separately — it's just a repetition of
// שביעי's last verse, which is already covered by aliyot[6]. Including it
// here would generate insights for the same verses twice.
export function getAliyahRefsForDay(dayOfWeek, aliyot) {
  const aliyahIndex = DAY_TO_ALIYAH[dayOfWeek];
  const indices = Array.isArray(aliyahIndex) ? [...aliyahIndex] : [aliyahIndex];

  return indices.map(i => aliyot[i]).filter(Boolean);
}

/**
 * @param {{year: number, month: number, day: number}} [explicitDate] Gregorian
 *   date to compute parts for, instead of the current moment. Anchored at
 *   noon UTC — always mid-afternoon in Jerusalem, so it can't roll onto the
 *   adjacent calendar day there.
 */
export function getJerusalemParts(explicitDate = null) {
  const now = explicitDate
    ? new Date(Date.UTC(explicitDate.year, explicitDate.month - 1, explicitDate.day, 12))
    : new Date();
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

// וזאת הברכה is never a regular Shabbat parasha, so the calendar API never
// hands it out — for its week it returns a holiday reading instead. Mirrors
// VEZOT_HABERACHA / isVezotHaberachaWeek in app.js; see the comment there.
export const VEZOT_HABERACHA = {
  name: 'וזאת הברכה',
  aliyot: [
    'Deuteronomy 33:1-7',
    'Deuteronomy 33:8-12',
    'Deuteronomy 33:13-17',
    'Deuteronomy 33:18-21',
    'Deuteronomy 33:22-26',
    'Deuteronomy 33:27-29',
    'Deuteronomy 34:1-12',
  ],
};

/**
 * True when the Shabbat ending this Jerusalem calendar day's week falls on
 * 16–22 Tishrei — the week וזאת הברכה is read.
 */
export function isVezotHaberachaWeek({ year, month, day }, dayOfWeek) {
  const shabbat = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + (6 - dayOfWeek), 12));
  const parts = new Intl.DateTimeFormat('en-u-ca-hebrew', {
    timeZone: 'Asia/Jerusalem',
    month: 'long',
    day: 'numeric',
  }).formatToParts(shabbat);
  const hebMonth = parts.find(p => p.type === 'month').value;
  const hebDay   = Number(parts.find(p => p.type === 'day').value);
  return hebMonth === 'Tishri' && hebDay >= 16 && hebDay <= 22;
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

// How many array levels deep the strings sit. For a commentary the leaves are
// individual comments, so this tells us how many of [chapter][verse][comment]
// Sefaria kept: it drops the levels the requested range doesn't span.
//   1 → one verse         [comment, …]
//   2 → one chapter       [verse][comment]          ("Genesis 28:10-22")
//   3 → across chapters   [chapter][verse][comment] ("Genesis 29:18-30:13")
export function nestingDepth(text) {
  if (!Array.isArray(text)) return 0;
  let deepest = 0;
  for (const child of text) deepest = Math.max(deepest, nestingDepth(child));
  return 1 + deepest;
}

/**
 * Index one commentator's Sefaria response by verse: Map of "Genesis 28:10" →
 * [comment, …]. Verses the commentator doesn't discuss are simply absent.
 *
 * Keyed by chapter:verse rather than flattened into a positional array, because
 * position drifts in two ways and every drift lands a comment on the wrong verse:
 *  - a verse with several comments (Rashi often has 3-5) would occupy several
 *    slots, pushing every later verse's commentary further out of place;
 *  - Sefaria trims trailing empty verses per chapter (Ramban on 29:18-30:13 has
 *    14 entries for the 18 verses of chapter 29), so in a multi-chapter range
 *    everything after the first chapter boundary shifts.
 *
 * `book` comes from the aliyah ref, not the response: a commentary's
 * `indexTitle` is "Rashi on Genesis", which isn't the mikra book name the verse
 * refs (and therefore the KV keys) are built from.
 */
export function commentaryByVerse(book, data, text) {
  const byVerse = new Map();
  const start = startOf(data);
  if (!book || !start || text == null) return byVerse;

  const put = (chapter, verse, comments) => {
    const list = (Array.isArray(comments) ? comments : [comments])
      .filter(c => typeof c === 'string' && c.trim())
      .map(c => c.trim());
    if (list.length) byVerse.set(`${book} ${chapter}:${verse}`, list);
  };

  const depth = nestingDepth(text);

  if (depth <= 1) {
    put(start.chapter, start.verse, text);
  } else if (depth === 2) {
    text.forEach((comments, v) => put(start.chapter, start.verse + v, comments));
  } else {
    text.forEach((chapterVerses, c) => {
      const chapter    = start.chapter + c;
      const firstVerse = c === 0 ? start.verse : 1;
      if (!Array.isArray(chapterVerses)) return;
      chapterVerses.forEach((comments, v) => put(chapter, firstVerse + v, comments));
    });
  }

  return byVerse;
}

// Where a Sefaria v3 response starts: { book, chapter, verse } as real numbers,
// or null when the response carries no usable position.
//
// Sefaria returns `sections` as STRINGS (["28", "10"]). Adding to one is string
// concatenation — "10" + 2 === "102" — which silently turned verse 12 into
// "Genesis 28:102" and, for multi-chapter ranges, chapter 29+1 into "291". The
// coercion has to happen before any arithmetic, and has to match app.js.
function startOf(data) {
  const book     = data?.indexTitle;
  const sections = data?.sections;
  if (!book || !Array.isArray(sections) || sections.length < 2) return null;

  const chapter = Number(sections[0]);
  const verse   = Number(sections[1]);
  if (!Number.isInteger(chapter) || !Number.isInteger(verse)) return null;
  return { book, chapter, verse };
}

// Walks text and the ref structure simultaneously so verses[i] and verseRefs[i]
// are guaranteed to point to the same segment — filtering is applied once, to both.
export function flattenVersesWithRefs(data, text) {
  const start = startOf(data);
  const book = start?.book;
  const hasRefs = !!start;
  const startChapter = hasRefs ? start.chapter : 0;
  const startVerse   = hasRefs ? start.verse   : 0;

  const pairs = [];

  function add(raw, chapter, verseNum) {
    if (typeof raw !== 'string' || !raw.trim()) return;
    pairs.push({
      verse:    raw.trim(),
      verseRef: hasRefs ? `${book} ${chapter}:${verseNum}` : null,
    });
  }

  if (!text) return pairs;

  if (typeof text === 'string') {
    add(text, startChapter, startVerse);
  } else if (text.every(v => typeof v === 'string')) {
    text.forEach((v, i) => add(v, startChapter, startVerse + i));
  } else {
    text.forEach((chapter, chIdx) => {
      const chapterNum  = startChapter + chIdx;
      const verseStart  = chIdx === 0 ? startVerse : 1;
      const verses = Array.isArray(chapter) ? chapter : (chapter ? [chapter] : []);
      verses.forEach((v, vIdx) => add(v, chapterNum, verseStart + vIdx));
    });
  }

  return pairs;
}

export async function fetchAliyahTexts(ref) {
  const mikraRef = convertRefFormat(ref);
  const mikraData = await fetchText(mikraRef);
  const mikraVersion = selectVersion(mikraData, ['Miqra according to the Masorah', "Tanach with Ta'amei Hamikra"]);
  const pairs = flattenVersesWithRefs(mikraData, mikraVersion?.text ?? null);
  return {
    verses:    pairs.map(p => p.verse),
    verseRefs: pairs.map(p => p.verseRef),
  };
}

/**
 * Returns one Map per commentator ("Genesis 28:10" → [comment, …]) — look
 * verses up by ref; see commentaryByVerse for why there is no positional array.
 */
export async function fetchCommentaries(ref) {
  const book = ref.slice(0, ref.lastIndexOf(' '));
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
    rashi:       commentaryByVerse(book, rashiData,       rashiVersion?.text       ?? null),
    ramban:      commentaryByVerse(book, rambanData,      rambanVersion?.text      ?? null),
    haamekDavar: commentaryByVerse(book, haamekDavarData, haamekDavarVersion?.text ?? null),
    ravHirsch:   commentaryByVerse(book, ravHirschData,   ravHirschVersion?.text   ?? null),
  };
}

// Bump whenever stored values may be wrong, because the key format is otherwise
// unchanged and generation is setnx: a suspect value would be read back as
// "already generated" and block the corrected pipeline from replacing it.
//   v1 → v2: the positional generator could attach a gem to the wrong verse.
//   v2 → v3: the commentary fed to Gemini was itself misaligned (each comment
//            took its own verse slot), and string `sections` produced garbage
//            refs like "Genesis 28:102". See commentaryByVerse / startOf.
export const KV_NAMESPACE = 'insights:v3';

export function refToKvKey(ref) {
  // "Genesis 1:1" → "insights:v3:Genesis:1:1"
  const spaceIdx = ref.lastIndexOf(' ');
  const book = ref.slice(0, spaceIdx);
  const [chapter, verse] = ref.slice(spaceIdx + 1).split(':');
  return `${KV_NAMESPACE}:${book}:${chapter}:${verse}`;
}
