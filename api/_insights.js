// Pure helpers for the פנינים (insights) pipeline: batching, prompt building,
// the Gemini response schema, and validation of what Gemini returns.
//
// Nothing here does I/O, so it can be exercised by a plain node script without
// a Vercel runtime, a Redis connection, or a Gemini API key.

export const BATCH_SIZE     = 6;
export const MAX_CONCURRENT = 3;
export const MODEL          = 'gemini-3-flash-preview';

export const COMMENTATORS = ['Rashi', 'Ramban', "Ha'amek Davar", 'Rav Hirsch'];

// ─── Refs ─────────────────────────────────────────────────────────────────────

// "Genesis 12:1" → { book: 'Genesis', chapter: 12, verse: 1 }
// Splits on the last space so multi-word books ("I Samuel") survive — same
// split refToKvKey uses in _sefaria.js.
export function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  const spaceIdx = ref.lastIndexOf(' ');
  if (spaceIdx < 1) return null;

  const book = ref.slice(0, spaceIdx).trim();
  const [chapterStr, verseStr] = ref.slice(spaceIdx + 1).split(':');
  const chapter = Number(chapterStr);
  const verse   = Number(verseStr);

  if (!book || !Number.isInteger(chapter) || !Number.isInteger(verse)) return null;
  return { book, chapter, verse };
}

export function formatRef({ book, chapter, verse }) {
  return `${book} ${chapter}:${verse}`;
}

// ─── Batching ─────────────────────────────────────────────────────────────────

/**
 * Zip verse refs, verse texts and the four aligned commentary arrays into one
 * record per verse. Verses with no ref (unstorable) or with no commentary at
 * all (nothing to extract) are dropped — the latter saves prompt tokens.
 */
export function buildVerseRecords(verseRefs, torahVerses, commentaries) {
  const records = [];

  for (let i = 0; i < torahVerses.length; i++) {
    const ref   = verseRefs[i];
    const parts = ref ? parseRef(ref) : null;
    if (!parts) continue;

    const rashi       = commentaries.rashi?.[i]       || [];
    const ramban      = commentaries.ramban?.[i]      || [];
    const haamekDavar = commentaries.haamekDavar?.[i] || [];
    const ravHirsch   = commentaries.ravHirsch?.[i]   || [];

    const hasCommentary =
      rashi.length || ramban.length || haamekDavar.length || ravHirsch.length;
    if (!hasCommentary) continue;

    records.push({
      ref,
      book:    parts.book,
      chapter: parts.chapter,
      verse:   parts.verse,
      text:    torahVerses[i],
      rashi, ramban, haamekDavar, ravHirsch,
    });
  }

  return records;
}

export function chunk(items, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are a Torah scholar with deep expertise in classical Jewish commentary.

You will receive a small batch of Torah verses. Each verse is introduced by a header line of the form:

=== Book Chapter:Verse ===

followed by the verse text and the raw commentary on that verse from up to 4 commentators: Rashi, Ramban, Ha'amek Davar (Netziv), and Rav Hirsch (whose text is in German).

Your task: extract only the "פנינים" — the gems — from these commentaries: midrashim, moral insights (תובנות מוסריות), and novel interpretations (חידושים). Skip plain pshat that merely restates the verse.

Rules:
- Output language: Hebrew only. Every insight must be written in Hebrew, including insights drawn from Rav Hirsch's German text.
- Keep each insight concise: 2-3 sentences maximum.
- Return one entry per verse that actually has gems. Omit verses that have none — do not pad with weak material.
- The "book", "chapter" and "verse" fields of each entry MUST be copied exactly from that verse's === header. Never emit a verse that does not appear in this batch, and never move an insight to a different verse than the one it was written on.
- Attribute each insight to the commentator it came from, using exactly one of: Rashi, Ramban, Ha'amek Davar, Rav Hirsch.`;

/**
 * One block per verse, headed by the real ref. The header is what the model
 * copies into book/chapter/verse — which is what makes misattribution
 * detectable in validateBatchResponse.
 */
export function buildBatchPrompt(records) {
  const blocks = records.map(r => {
    const lines = [`=== ${r.ref} ===`, `פסוק: ${r.text}`];
    if (r.rashi.length)       lines.push(`רש"י: ${r.rashi.join(' | ')}`);
    if (r.ramban.length)      lines.push(`רמב"ן: ${r.ramban.join(' | ')}`);
    if (r.haamekDavar.length) lines.push(`העמק דבר: ${r.haamekDavar.join(' | ')}`);
    if (r.ravHirsch.length)   lines.push(`Rav Hirsch: ${r.ravHirsch.join(' | ')}`);
    return lines.join('\n');
  });

  return `Here are ${records.length} verses with their commentaries:\n\n${blocks.join('\n\n')}\n\nExtract the פנינים and return JSON matching the schema.`;
}

// ─── Response schema ──────────────────────────────────────────────────────────

export const INSIGHTS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    insights: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          book:    { type: 'STRING' },
          chapter: { type: 'INTEGER' },
          verse:   { type: 'INTEGER' },
          pearls: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                commentator: { type: 'STRING', enum: COMMENTATORS },
                insight:     { type: 'STRING' },
              },
              required: ['commentator', 'insight'],
              propertyOrdering: ['commentator', 'insight'],
            },
          },
        },
        required: ['book', 'chapter', 'verse', 'pearls'],
        propertyOrdering: ['book', 'chapter', 'verse', 'pearls'],
      },
    },
  },
  required: ['insights'],
};

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Keep only entries whose book/chapter/verse names a verse that was actually in
 * this batch, and only pearls with a known commentator and non-empty insight.
 * Anything else is dropped and logged — a gem can never land on a verse the
 * model was not given.
 *
 * Every verse in `records` is included in the result, even with an empty
 * `pearls` array — the model is told to omit verses with no gems, but the
 * caller still needs to tell "attempted, nothing found" apart from "never
 * attempted" so it knows what's safe to skip on a later gap-fill.
 *
 * @returns {Array<{ref: string, pearls: Array<{commentator: string, insight: string}>}>}
 */
export function validateBatchResponse(parsed, records, log = console.warn) {
  const allowed = new Set(records.map(r => r.ref));
  const entries = Array.isArray(parsed?.insights) ? parsed.insights : [];
  const byRef   = new Map(records.map(r => [r.ref, []]));

  for (const entry of entries) {
    const chapter = Number(entry?.chapter);
    const verse   = Number(entry?.verse);
    const book    = typeof entry?.book === 'string' ? entry.book.trim() : '';

    if (!book || !Number.isInteger(chapter) || !Number.isInteger(verse)) {
      log(`[insights] dropping entry with unusable ref: ${JSON.stringify(entry?.book)} ${entry?.chapter}:${entry?.verse}`);
      continue;
    }

    const ref = formatRef({ book, chapter, verse });
    if (!allowed.has(ref)) {
      log(`[insights] dropping out-of-batch ref "${ref}" (batch: ${records[0]?.ref}…${records[records.length - 1]?.ref})`);
      continue;
    }

    const pearls = (Array.isArray(entry.pearls) ? entry.pearls : []).filter(p => {
      const ok = COMMENTATORS.includes(p?.commentator) && typeof p?.insight === 'string' && p.insight.trim();
      if (!ok) log(`[insights] dropping malformed pearl on ${ref}: ${JSON.stringify(p)?.slice(0, 120)}`);
      return ok;
    }).map(p => ({ commentator: p.commentator, insight: p.insight.trim() }));

    if (pearls.length === 0) continue;

    // A model that splits one verse across two entries gets merged, not dropped.
    byRef.get(ref).push(...pearls);
  }

  return [...byRef].map(([ref, pearls]) => ({ ref, pearls }));
}
