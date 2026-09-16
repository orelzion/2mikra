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
 * Returns the weekday in Jerusalem (midnight-based, not halachic sunset) for a
 * given moment. Uses Intl.DateTimeFormat to avoid relying on the user's local
 * timezone.
 * @param {Date} [date] Defaults to now.
 * @returns {number} 0=Sunday … 6=Saturday
 */
function getJerusalemDayOfWeek(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
  }).formatToParts(date);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const map = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  return map[weekday];
}

/**
 * Returns the Jerusalem calendar date (Gregorian y/m/d) for a given moment.
 */
function getJerusalemDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    year:  parts.find(p => p.type === 'year').value,
    month: parts.find(p => p.type === 'month').value,
    day:   parts.find(p => p.type === 'day').value,
  };
}

/**
 * A Date anchored at noon UTC on a given Jerusalem calendar day. Noon UTC is
 * always mid-afternoon in Jerusalem, so it can never round to the wrong
 * calendar day there — which makes it safe to shift by whole days with
 * setUTCDate and re-derive the weekday/date parts without DST edge cases.
 */
function jerusalemAnchor({ year, month, day }) {
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
}

function jerusalemTodayAnchor() {
  return jerusalemAnchor(getJerusalemDateParts(new Date()));
}

function shiftAnchorDays(anchor, delta) {
  const next = new Date(anchor);
  next.setUTCDate(next.getUTCDate() + delta);
  return next;
}

function isSameJerusalemDay(a, b) {
  const pa = getJerusalemDateParts(a);
  const pb = getJerusalemDateParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

// The day currently being viewed. Defaults to today; the back/next controls
// move it a day at a time and trigger a full re-render.
let viewAnchor = jerusalemTodayAnchor();

// Maps Jerusalem weekday → aliyah array index/indices.
// Saturday returns null (Shabbat rest screen). Maftir is not a separate
// aliyah — on an ordinary week it re-reads the tail of שביעי from the same
// scroll, so it's only marked in place within שביעי's verses (see
// buildMaftirMarkerEl / getMaftirStartRef), never fetched on its own.
const DAY_TO_ALIYAH = {
  0: 0,       // Sunday    → 1st aliyah
  1: 1,       // Monday    → 2nd aliyah
  2: 2,       // Tuesday   → 3rd aliyah
  3: 3,       // Wednesday → 4th aliyah
  4: 4,       // Thursday  → 5th aliyah
  5: [5, 6],  // Friday    → 6th & 7th aliyot
  6: null,    // Saturday  → Shabbat screen
};

const ALIYAH_SECTION_META = {
  0: { short: 'ראשון', full: 'עליית ראשון' },
  1: { short: 'שני', full: 'עליית שני' },
  2: { short: 'שלישי', full: 'עליית שלישי' },
  3: { short: 'רביעי', full: 'עליית רביעי' },
  4: { short: 'חמישי', full: 'עליית חמישי' },
  5: { short: 'שישי', full: 'עליית שישי' },
  6: { short: 'שביעי', full: 'עליית שביעי' },
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

/**
 * Extracts the first "Book Chapter:Verse" from a (possibly ranged) Sefaria
 * ref, e.g. "Exodus 27:20-28:12" → "Exodus 27:20". Used to locate where
 * aliyot[7] (Maftir) actually starts among the already-rendered שביעי
 * verses, which are keyed by this same "Book Chapter:Verse" shape.
 */
function getRefRangeStart(ref) {
  const match = ref.match(/^(.+?) (\d+):(\d+)/);
  return match ? `${match[1]} ${match[2]}:${match[3]}` : null;
}

function buildSteinsaltzRef(ref) {
  return `Steinsaltz_on_${convertRefFormat(ref)}`;
}

function buildOnkelosRef(ref) {
  return `Onkelos_${convertRefFormat(ref)}`;
}


// ─── Sefaria API ──────────────────────────────────────────────────────────────

/**
 * @param {{year: string, month: string, day: string}} [dateParts] Explicit
 *   Gregorian date to fetch the calendar for. Omitted for "today", matching
 *   the endpoint's own default and preserving existing behavior exactly.
 */
async function fetchCalendar(dateParts = null) {
  const params = new URLSearchParams({ diaspora: '0' });
  if (dateParts) {
    params.set('year', dateParts.year);
    params.set('month', dateParts.month);
    params.set('day', dateParts.day);
  }
  const res = await fetch(`${BASE_URL}/api/calendars?${params.toString()}`);
  if (!res.ok) throw new Error(`Calendar HTTP ${res.status}`);
  return res.json();
}

async function getCurrentWeekParashat(dateParts = null) {
  const calendar = await fetchCalendar(dateParts);
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
 * Walk the mikra text and its ref structure together so verses[i] and
 * verseRefs[i] always point at the same segment — filtering is applied once,
 * to both. Mirrors flattenVersesWithRefs in api/_sefaria.js so the client and
 * the insights generator derive identical refs.
 */
function flattenVersesWithRefs(data, text) {
  const book     = data?.indexTitle;
  const sections = data?.sections;
  const hasRefs  = !!(book && sections && sections.length >= 2);
  const startChapter = hasRefs ? sections[0] : 0;
  const startVerse   = hasRefs ? sections[1] : 0;

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
      const chapterNum = startChapter + chIdx;
      const verseStart = chIdx === 0 ? startVerse : 1;
      const verses = Array.isArray(chapter) ? chapter : (chapter ? [chapter] : []);
      verses.forEach((v, vIdx) => add(v, chapterNum, verseStart + vIdx));
    });
  }

  return pairs;
}

/**
 * Fetch Mikra, Steinsaltz, and Onkelos in parallel for a given ref string.
 * Returns { mikra, mikraRefs, steinsaltz, onkelos }, where mikra is a flat
 * array of verse strings and mikraRefs aligns 1:1 with it ("Genesis 12:1").
 * Steinsaltz and Onkelos are returned raw for flattenVerses.
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

  const pairs = flattenVersesWithRefs(mikraData, mikraVersion?.text ?? null);

  return {
    mikra:      pairs.map(p => p.verse),
    mikraRefs:  pairs.map(p => p.verseRef),
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

  // mikra arrives pre-flattened from fetchAliyahTexts, paired with mikraRefs
  const mikraVerses      = texts.mikra || [];
  const mikraRefs        = texts.mikraRefs || [];
  const steinsaltzVerses = flattenVerses(texts.steinsaltz);
  const onkelosVerses    = flattenVerses(texts.onkelos);

  const count = Math.max(mikraVerses.length, steinsaltzVerses.length, onkelosVerses.length);

    for (let i = 0; i < count; i++) {
    const triplet = document.createElement('div');
    triplet.className = 'verse-triplet';
    triplet.dataset.verseIndex = i;
    if (mikraRefs[i]) triplet.dataset.verseRef = mikraRefs[i];

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

function createSectionSeparator(title) {
  const separator = document.createElement('div');
  separator.className = 'aliyah-section-separator';

  const heading = document.createElement('h3');
  heading.className = 'aliyah-section-title';
  heading.textContent = title;

  separator.appendChild(heading);
  return separator;
}

function getAliyahSectionsForDay(dayOfWeek, aliyot) {
  const aliyahIndex = DAY_TO_ALIYAH[dayOfWeek];
  const indices = Array.isArray(aliyahIndex) ? [...aliyahIndex] : [aliyahIndex];

  return indices
    .filter(index => aliyot?.[index])
    .map(index => ({
      index,
      ref: aliyot[index],
      shortLabel: ALIYAH_SECTION_META[index]?.short ?? 'עלייה',
      sectionLabel: ALIYAH_SECTION_META[index]?.full ?? 'עלייה',
    }));
}

/**
 * מפטיר isn't a separate aliyah — it re-reads the tail end of שביעי, which is
 * already fully rendered as part of it. So it needs no separate fetch and no
 * duplicated verses, just a marker dropped in front of the verse where it
 * actually begins.
 */
function buildMaftirMarkerEl() {
  const marker = document.createElement('div');
  marker.className = 'maftir-marker';
  marker.textContent = 'מפטיר';
  return marker;
}

/**
 * Finds which of שביעי's already-fetched verse refs is where מפטיר begins.
 * Sefaria's aliyot[7] is only populated when Maftir is a genuinely different
 * reading (e.g. Rosh Chodesh, from a separate scroll) — on an ordinary week
 * it's absent even though Maftir still happens, it just repeats part of
 * שביעי. So: use aliyot[7]'s ref when it names one of שביעי's own verses,
 * and otherwise fall back to the standard custom of repeating (at least)
 * the last three verses.
 */
function getMaftirStartRef(sevaRefs, maftirRef) {
  const explicitStart = maftirRef ? getRefRangeStart(maftirRef) : null;
  if (explicitStart && sevaRefs.includes(explicitStart)) {
    return explicitStart;
  }
  return sevaRefs.length > 0 ? sevaRefs[Math.max(0, sevaRefs.length - 3)] : null;
}


// ─── Main Render ──────────────────────────────────────────────────────────────

function updateDateNav() {
  const labelEl = document.getElementById('date-nav-label');
  if (!labelEl) return;
  const isToday = isSameJerusalemDay(viewAnchor, new Date());
  labelEl.textContent = isToday
    ? 'היום'
    : new Intl.DateTimeFormat('he-IL', {
        timeZone: 'Asia/Jerusalem',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(viewAnchor);
}

function setDateNavDisabled(disabled) {
  const prevBtn = document.getElementById('date-prev');
  const nextBtn = document.getElementById('date-next');
  if (prevBtn) prevBtn.disabled = disabled;
  if (nextBtn) nextBtn.disabled = disabled;
}

async function render() {
  const parashaNameEl = document.getElementById('parasha-name');
  const aliyahNameEl  = document.getElementById('aliyah-name');
  const containerEl   = document.getElementById('content-container');

  updateDateNav();

  // Always the explicit viewed date, never omitted for "today" — if the tab
  // is left open across Jerusalem midnight, viewAnchor still names the day
  // on screen even though it's no longer the real "today", and generation
  // must target that same day, not whatever the server now considers current.
  const dateParts  = getJerusalemDateParts(viewAnchor);
  const dayOfWeek  = getJerusalemDayOfWeek(viewAnchor);

  setDateNavDisabled(true);
  try {
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
      const parashat = await getCurrentWeekParashat(dateParts);
      if (!parashat) {
        containerEl.innerHTML = '';
        const err = document.createElement('div');
        err.className   = 'error';
        err.textContent = 'לא נמצאה פרשת השבוע';
        containerEl.appendChild(err);
        return;
      }

      parashaNameEl.textContent = parashat.name;

      const aliyahSections = getAliyahSectionsForDay(dayOfWeek, parashat.aliyot);

      if (aliyahSections.length === 0) {
        containerEl.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'error';
        err.textContent = 'לא נמצאו עליות זמינות להיום';
        containerEl.appendChild(err);
        return;
      }

      aliyahNameEl.textContent = aliyahSections.map(section => section.shortLabel).join(' · ');

      // Fetch all needed aliyot in parallel
      const aliyahRefs = aliyahSections.map(section => section.ref);
      const allTexts   = await Promise.all(aliyahRefs.map(fetchAliyahTexts));

      containerEl.innerHTML = '';

      allTexts.forEach((texts, pos) => {
        const section = aliyahSections[pos];

        containerEl.appendChild(createSectionSeparator(section.sectionLabel));

        const groupEl = buildVerseGroupEl(texts);
        containerEl.appendChild(groupEl);
      });

      // Friday completes the parasha — mark where מפטיר starts within
      // שביעי's already-rendered verses. Maftir happens every week, whether
      // or not Sefaria's calendar data calls out a distinct aliyot[7].
      if (dayOfWeek === 5) {
        const sevaTexts = allTexts[allTexts.length - 1];
        const sevaRefs  = (sevaTexts.mikraRefs || []).filter(Boolean);
        const maftirStart = getMaftirStartRef(sevaRefs, parashat.aliyot?.[7]);
        const maftirTriplet = maftirStart
          ? [...containerEl.querySelectorAll('.verse-triplet')].find(t => t.dataset.verseRef === maftirStart)
          : null;
        if (maftirTriplet) {
          maftirTriplet.before(buildMaftirMarkerEl());
        }
      }

      const insightsStatus = await loadPreGeneratedInsights(containerEl, { showFallbackMessage: true, dateParts });
      if (insightsStatus.status === 'error') {
        console.warn('[insights] unavailable:', insightsStatus.reason || 'unknown');
      }

    } catch (err) {
      containerEl.innerHTML = '';
      const errEl = document.createElement('div');
      errEl.className   = 'error';
      errEl.textContent = 'שגיאה בטעינת הטקסטים';
      containerEl.appendChild(errEl);
    }
  } finally {
    setDateNavDisabled(false);
  }
}

/**
 * Show why the פנינים aren't here, optionally with a button that generates
 * them on demand. There is no cron anymore, so this button is the only way
 * to generate insights — shown at the top of the content so it's the first
 * thing visible instead of something to scroll past everything to find.
 */
function renderInsightsFallbackMessage(containerEl, message, { canRetry = false, dateParts = null } = {}) {
  const fallback = document.createElement('div');
  fallback.className = 'insights-fallback';

  const text = document.createElement('p');
  text.className = 'insights-fallback-text';
  text.textContent = message;
  fallback.appendChild(text);

  if (canRetry) {
    fallback.appendChild(buildInsightsRetryButton(containerEl, fallback, text, dateParts));
  }

  containerEl.prepend(fallback);
}

function buildInsightsRetryButton(containerEl, fallbackEl, textEl, dateParts) {
  // Snapshotted now, not read at click time: shiftAnchorDays always assigns a
  // *new* Date object, so this stays the anchor that was showing when the
  // button was built even after viewAnchor is reassigned by navigation.
  const requestedAnchor = viewAnchor;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'insights-retry';
  button.textContent = 'צור פנינים';

  button.addEventListener('click', async () => {
    button.disabled = true;
    textEl.textContent = 'מייצר פנינים… הפעולה עשויה לקחת עד דקה.';

    const params = new URLSearchParams();
    if (dateParts) {
      params.set('year', dateParts.year);
      params.set('month', dateParts.month);
      params.set('day', dateParts.day);
    }
    const url = '/api/generate-daily-insights' + (params.toString() ? `?${params}` : '');

    let failure = null;
    try {
      // Generation runs to a ~48s deadline server-side; allow for the round trip.
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(90000),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        failure = data.error === 'already running'
          ? 'הייצור כבר רץ ברקע. נסה שוב בעוד רגע.'
          : data.error === 'daily limit reached'
            ? 'הגעת למכסת הניסיונות להיום.'
            : 'לא הצלחנו לייצר פנינים כרגע.';
      }
    } catch {
      failure = 'לא הצלחנו לייצר פנינים כרגע.';
    }

    // The user may have navigated to a different day while this was in
    // flight — containerEl now holds that day's content, so don't overwrite
    // it with a status message or a lookup for the day this button was for.
    if (viewAnchor !== requestedAnchor) return;

    if (failure) {
      textEl.textContent = failure;
      button.disabled = false;
      return;
    }

    // A partial run still leaves gems worth showing, so re-read either way.
    fallbackEl.remove();
    await loadPreGeneratedInsights(containerEl, { showFallbackMessage: true, dateParts });
  });

  return button;
}

/**
 * Load and render pre-generated insights. A verse ref that's present in the
 * response (even with an empty array) has been attempted; one that's absent
 * has not. Retry is only worth offering when some verse was never attempted
 * — a fully-attempted reading with no gems anywhere has nothing more to gain
 * from generating again.
 * @returns {{status: 'loaded'|'partial'|'empty'|'error', reason?: string, renderedCount?: number}}
 */
async function loadPreGeneratedInsights(containerEl, { showFallbackMessage = false, dateParts = null } = {}) {
  try {
    const triplets = [...containerEl.querySelectorAll('.verse-triplet')]
      .filter(t => t.dataset.verseRef);

    if (triplets.length === 0) {
      if (showFallbackMessage) {
        renderInsightsFallbackMessage(containerEl, 'אין פנינים זמינים להיום.');
      }
      return { status: 'empty', reason: 'no verse refs' };
    }

    const refs = [...new Set(triplets.map(t => t.dataset.verseRef))];
    const res = await fetch(`/api/daily-insights?refs=${encodeURIComponent(refs.join(','))}`, { cache: 'no-store' });
    if (!res.ok) {
      if (showFallbackMessage) {
        renderInsightsFallbackMessage(containerEl, 'פנינים אינם זמינים כרגע.', { canRetry: true, dateParts });
      }
      return { status: 'error', reason: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const insightsMap = data.insights || {};

    let renderedCount  = 0;
    let attemptedCount = 0;

    for (const triplet of triplets) {
      const ref = triplet.dataset.verseRef;
      if (Object.prototype.hasOwnProperty.call(insightsMap, ref)) attemptedCount += 1;

      const insights = insightsMap[ref];
      if (!insights || insights.length === 0) continue;
      // Guard against a re-render appending a second פנינים block
      if (triplet.querySelector('.mefarshim-container')) continue;

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
        const COMMENTATOR_HE = {
          'Rashi': 'רש״י',
          'Ramban': 'רמב״ן',
          "Ha'amek Davar": 'העמק דבר',
          'Rav Hirsch': 'רש״ר הירש',
        };
        dibur.textContent = (COMMENTATOR_HE[insight.commentator] ?? insight.commentator) + ':';

        const text = document.createElement('span');
        text.textContent = insight.insight;

        item.appendChild(dibur);
        item.appendChild(text);
        grid.appendChild(item);
      }

      insightsLayer.appendChild(grid);
      triplet.appendChild(insightsLayer);
      renderedCount += 1;
    }

    // Some verses were never generated at all (not even "no gems found") —
    // offer retry so a run that hit the deadline or a batch failure can be
    // completed, since there's no cron left to gap-fill it automatically.
    if (attemptedCount < triplets.length) {
      if (showFallbackMessage) {
        const message = renderedCount > 0 ? 'חלק מהפנינים עדיין לא נוצרו.' : 'אין פנינים זמינים להיום.';
        renderInsightsFallbackMessage(containerEl, message, { canRetry: true, dateParts });
      }
      return { status: 'partial', renderedCount, attemptedCount, total: triplets.length };
    }

    if (renderedCount === 0) {
      // Fully attempted, genuinely nothing found — retrying can't help.
      if (showFallbackMessage) {
        renderInsightsFallbackMessage(containerEl, 'אין פנינים זמינים לקטע זה.');
      }
      return { status: 'empty', reason: 'no gems for any verse' };
    }

    return { status: 'loaded', renderedCount };
  } catch {
    if (showFallbackMessage) {
      renderInsightsFallbackMessage(containerEl, 'פנינים אינם זמינים כרגע.', { canRetry: true, dateParts });
    }
    return { status: 'error', reason: 'fetch failed' };
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

  const prevBtn = document.getElementById('date-prev');
  const nextBtn = document.getElementById('date-next');
  prevBtn?.addEventListener('click', () => {
    viewAnchor = shiftAnchorDays(viewAnchor, -1);
    render();
  });
  nextBtn?.addEventListener('click', () => {
    viewAnchor = shiftAnchorDays(viewAnchor, 1);
    render();
  });

  initFontSize();
  syncCollapsedHeader();
  render();
});
