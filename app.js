// Mikra — vanilla JS app

// ─── Sanitization ────────────────────────────────────────────────────────────

/**
 * Sanitize HTML from Sefaria API responses.
 * Allows only <b> tags. Strips span, br, and all other markup.
 * Falls back to a simple regex stripper if DOMPurify is not loaded.
 */
function sanitize(html) {
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['b'], ALLOWED_ATTR: [] });
  }
  // Fallback: strip all tags except <b> and </b>
  return html
    .replace(/<(?!\/?b\b)[^>]*>/gi, '')  // remove non-<b> tags
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&thinsp;/g, '\u2009');
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.sefaria.org';

// ─── Date / Aliyah Logic ─────────────────────────────────────────────────────

/**
 * Returns the current weekday in Jerusalem (midnight-based, not halachic sunset).
 * Uses Intl.DateTimeFormat to avoid relying on the user's local timezone.
 * @returns {number} 0=Sunday … 6=Saturday
 */
function getJerusalemDayOfWeek() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
  }).formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const map = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  return map[weekday];
}

// Maps Jerusalem weekday → aliyah array index/indices.
// Friday returns [5, 6] (6th & 7th aliyot, Maftir excluded).
// Saturday returns null (Shabbat rest screen).
const DAY_TO_ALIYAH = {
  0: 0,       // Sunday    → 1st aliyah
  1: 1,       // Monday    → 2nd aliyah
  2: 2,       // Tuesday   → 3rd aliyah
  3: 3,       // Wednesday → 4th aliyah
  4: 4,       // Thursday  → 5th aliyah
  5: [5, 6],  // Friday    → 6th & 7th aliyot
  6: null,    // Saturday  → Shabbat screen
};

// ─── Font Size ────────────────────────────────────────────────────────────────

function initFontSize() {
  document.documentElement.style.setProperty('--font-size', 20);
}

// ─── Ref Format Conversion ───────────────────────────────────────────────────

/**
 * Converts a Sefaria ref like "Exodus 27:20-28:12" to URL path format "Exodus.27.20-28.12".
 * Handles multi-word book names (e.g. "I Samuel") by replacing all spaces and colons.
 */
function convertRefFormat(ref) {
  // Replace spaces between words and digits with dots, colons with dots.
  // "Exodus 27:20-28:12" → "Exodus.27.20-28.12"
  // "I Samuel 15:2-34"   → "I_Samuel.15.2-34"  (multi-word handled below)
  return ref
    .replace(/ (\d)/g, '.$1')   // space before chapter/verse digits → dot
    .replace(/:/g, '.');         // colons → dots
    // Note: book names with internal spaces (e.g. "I Samuel") are already handled
    // because the pattern above only replaces spaces directly before a digit.
}

function buildSteinsaltzRef(ref) {
  return `Steinsaltz_on_${convertRefFormat(ref)}`;
}

function buildOnkelosRef(ref) {
  return `Onkelos_${convertRefFormat(ref)}`;
}


// ─── Sefaria API ──────────────────────────────────────────────────────────────

async function fetchCalendar() {
  const res = await fetch(`${BASE_URL}/api/calendars`);
  if (!res.ok) throw new Error(`Calendar HTTP ${res.status}`);
  return res.json();
}

async function getCurrentWeekParashat() {
  const calendar = await fetchCalendar();
  const item = (calendar.calendar_items || []).find(
    i => i.title && i.title.en === 'Parashat Hashavua'
  );
  if (!item) return null;
  return {
    // displayValue is an object {en, he} — use Hebrew
    name: item.displayValue.he || item.displayValue.en,
    aliyot: item.extraDetails?.aliyot || [],  // array of strings: "Exodus 27:20-28:12"
  };
}

/**
 * Fetch a single text ref via the v3 API.
 * Returns null on failure (never throws).
 */
async function fetchText(ref) {
  try {
    const res = await fetch(`${BASE_URL}/api/v3/texts/${encodeURIComponent(ref)}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Pick the preferred version from a v3 API response.
 * Returns the matching version object, or the first available, or null.
 */
function selectVersion(data, preferredTitles) {
  const versions = data?.versions;
  if (!versions || versions.length === 0) return null;
  for (const title of preferredTitles) {
    const found = versions.find(v => v.versionTitle === title);
    if (found) return found;
  }
  return versions[0];
}

/**
 * Fetch Mikra, Steinsaltz, and Onkelos in parallel for a given ref string.
 * Returns { mikra, steinsaltz, onkelos } where each is an array of verses (strings),
 * or null if unavailable.
 */
async function fetchAliyahTexts(ref) {
  const mikraRef      = convertRefFormat(ref);
  const steinsaltzRef = buildSteinsaltzRef(ref);
  const onkelosRef    = buildOnkelosRef(ref);

  const [mikraData, steinsaltzData, onkelosData] = await Promise.all([
    fetchText(mikraRef),
    fetchText(steinsaltzRef),
    fetchText(onkelosRef),
  ]);

  const mikraVersion      = selectVersion(mikraData, ['Miqra according to the Masorah', "Tanach with Ta'amei Hamikra"]);
  const steinsaltzVersion = selectVersion(steinsaltzData, ['The Koren Steinsaltz Tanakh HaMevoar - Hebrew']);
  const onkelosVersion    = selectVersion(onkelosData, ['Sifsei Chachomim Chumash, Metsudah Publications, 2009', 'Onkelos Exodus']);

  return {
    mikra:      mikraVersion?.text      ?? null,
    steinsaltz: steinsaltzVersion?.text ?? null,
    onkelos:    onkelosVersion?.text    ?? null,
  };
}


// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Flatten a nested verse array (Sefaria returns arrays-of-arrays for spanning
 * ranges: text[chapter][verse]) into a flat array of verse strings, preserving
 * verse order across chapter boundaries.
 */
function flattenVerses(text) {
  if (!text) return [];
  if (typeof text === 'string') return [text.trim()].filter(Boolean);
  // Array of strings — single chapter
  if (text.every(v => typeof v === 'string')) {
    return text.map(v => v.trim()).filter(Boolean);
  }
  // Array of arrays — spanning chapters; flatten one level at a time
  return text.flatMap(chapter => {
    if (typeof chapter === 'string') return [chapter.trim()].filter(Boolean);
    return chapter.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  });
}


/**
 * Build and return a container DOM element for one aliyah, laid out as:
 * verse₁ | steinsaltz₁ | onkelos₁ · verse₂ | steinsaltz₂ | onkelos₂ · …
 */
function buildVerseGroupEl(texts) {
  const group = document.createElement('div');
  group.className = 'verse-group';

  const mikraVerses      = flattenVerses(texts.mikra);
  const steinsaltzVerses = flattenVerses(texts.steinsaltz);
  const onkelosVerses    = flattenVerses(texts.onkelos);

  const count = Math.max(mikraVerses.length, steinsaltzVerses.length, onkelosVerses.length);

    for (let i = 0; i < count; i++) {
    const triplet = document.createElement('div');
    triplet.className = 'verse-triplet';
    triplet.dataset.verseIndex = i;

    // ── Mikra (contains HTML entities and <b> paseq markers) ──
    if (mikraVerses[i] !== undefined) {
      const layer = document.createElement('div');
      layer.className = 'layer layer-mikra';
      if (i === 0) {
        const lbl = document.createElement('span');
        lbl.className = 'layer-label';
        lbl.textContent = 'מקרא';
        layer.appendChild(lbl);
      }
      const p = document.createElement('p');
      p.className = 'verse';
      p.innerHTML = sanitize(mikraVerses[i]);
      layer.appendChild(p);
      triplet.appendChild(layer);
    }

    // ── Steinsaltz ──
    if (steinsaltzVerses[i] !== undefined) {
      const layer = document.createElement('div');
      layer.className = 'layer layer-steinsaltz';
      const lbl = document.createElement('span');
      lbl.className = 'section-label';
      lbl.textContent = 'ביאור שטיינזלץ:';
      layer.appendChild(lbl);
      const p = document.createElement('p');
      p.className = 'verse';
      p.innerHTML = sanitize(steinsaltzVerses[i]);
      layer.appendChild(p);
      triplet.appendChild(layer);
    }

    // ── Onkelos (may also contain HTML entities) ──
    if (onkelosVerses[i] !== undefined) {
      const layer = document.createElement('div');
      layer.className = 'layer layer-onkelos';
      const lbl = document.createElement('span');
      lbl.className = 'section-label';
      lbl.textContent = 'תרגום אונקלוס:';
      layer.appendChild(lbl);
      const p = document.createElement('p');
      p.className = 'verse';
      p.innerHTML = sanitize(onkelosVerses[i]);
      layer.appendChild(p);
      triplet.appendChild(layer);
    }

    group.appendChild(triplet);
  }

  return group;
}


// ─── Main Render ──────────────────────────────────────────────────────────────

async function render() {
  const parashaNameEl = document.getElementById('parasha-name');
  const aliyahNameEl  = document.getElementById('aliyah-name');
  const containerEl   = document.getElementById('content-container');

  const dayOfWeek = getJerusalemDayOfWeek();

  // Saturday — Shabbat rest screen
  if (dayOfWeek === 6) {
    parashaNameEl.textContent = 'שבת שלום';
    aliyahNameEl.textContent  = '';
    containerEl.innerHTML     = '';
    const msg = document.createElement('div');
    msg.className   = 'shabbat-message';
    msg.textContent = 'שַׁבָּת שָׁלוֹם';
    containerEl.appendChild(msg);
    return;
  }

  containerEl.innerHTML = '<div class="loading">טוען טקסטים…</div>';

  try {
    const parashat = await getCurrentWeekParashat();
    if (!parashat) {
      containerEl.innerHTML = '';
      const err = document.createElement('div');
      err.className   = 'error';
      err.textContent = 'לא נמצאה פרשת השבוע';
      containerEl.appendChild(err);
      return;
    }

    parashaNameEl.textContent = parashat.name;

    const aliyahIndex = DAY_TO_ALIYAH[dayOfWeek];
    const indices = Array.isArray(aliyahIndex) ? aliyahIndex : [aliyahIndex];

    // Hebrew ordinal labels
    const HEBREW_ORDINALS = ['ראשונה', 'שנייה', 'שלישית', 'רביעית', 'חמישית', 'שישית', 'שביעית'];

    // Fetch all needed aliyot in parallel
    const aliyahRefs = indices.map(i => parashat.aliyot[i]);
    const allTexts   = await Promise.all(aliyahRefs.map(fetchAliyahTexts));

    containerEl.innerHTML = '';

    allTexts.forEach((texts, pos) => {
      const idx = indices[pos];
      aliyahNameEl.textContent = `עליה ${HEBREW_ORDINALS[idx] || idx + 1}`;

      const groupEl = buildVerseGroupEl(texts);
      containerEl.appendChild(groupEl);
    });

    loadPreGeneratedInsights(containerEl);

  } catch (err) {
    containerEl.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className   = 'error';
    errEl.textContent = 'שגיאה בטעינת הטקסטים';
    containerEl.appendChild(errEl);
  }
}

async function loadPreGeneratedInsights(containerEl) {
  try {
    const res = await fetch('/api/daily-insights');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.insights) return;

    const triplets = containerEl.querySelectorAll('.verse-triplet');
    for (const [verseIdx, insights] of Object.entries(data.insights)) {
      const triplet = triplets[verseIdx];
      if (!triplet || !insights || insights.length === 0) continue;

      const insightsLayer = document.createElement('div');
      insightsLayer.className = 'mefarshim-container';

      const label = document.createElement('span');
      label.className = 'section-label';
      label.textContent = 'פנינים:';
      insightsLayer.appendChild(label);

      const grid = document.createElement('div');
      grid.className = 'mefarshim-grid';

      for (const insight of insights) {
        const item = document.createElement('div');
        item.className = 'mefaresh-item';

        const dibur = document.createElement('span');
        dibur.className = 'dibur-hamatchil';
        dibur.textContent = insight.commentator + ':';

        const text = document.createElement('span');
        text.textContent = insight.insight;

        item.appendChild(dibur);
        item.appendChild(text);
        grid.appendChild(item);
      }

      insightsLayer.appendChild(grid);
      triplet.appendChild(insightsLayer);
    }
  } catch {
    // Insights are a nice-to-have; fail silently
  }
}

// ─── Service Worker Registration ──────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch(() => { /* SW is an enhancement; fail silently */ });
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const headerEl = document.querySelector('.header');
  const collapseThreshold = 40;

  const syncCollapsedHeader = () => {
    if (!headerEl) return;
    headerEl.classList.toggle('is-collapsed', window.scrollY > collapseThreshold);
  };

  window.addEventListener('scroll', syncCollapsedHeader, { passive: true });

  initFontSize();
  syncCollapsedHeader();
  render();
});
