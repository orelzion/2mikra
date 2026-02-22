# Gemini Commentary Insights (פנינים) — Design

**Date:** 2026-02-22
**Status:** Approved

## Summary

Add a "פנינים" (Gems) section below Onkelos for each verse. Gemini curates 
insights from 4 commentators — רש"י, רמב"ן, רש"ר הירש, הנצי"ב — filtering 
for only the interesting material: midrashim, moral insights (תובנות מוסריות), 
and novel interpretations (חידושים). Plain pshat explanations are skipped.

## Context

- App: Mikra PWA — vanilla HTML/CSS/JS, hosted on Vercel
- Gemini API key: set as `GEMINI_API_KEY` in Vercel environment variables
- Sefaria API refs verified working for all 4 commentators
- Background: Phase 2 task in tasks.md (line 95) — replaces the old 
  "button per Aliyah" plan with this richer per-verse design

## Architecture

### Data Flow

```
Page Load
  ├── (existing) Fetch Mikra + Steinsaltz + Onkelos → render main content
  └── (background) 
        ├── Fetch 4 commentaries from Sefaria in parallel
        ├── POST to /api/insights (Vercel serverless function)
        │     └── Gemini API call with structured prompt
        └── Inject פנינים boxes into existing verse triplets
```

### Commentary Sefaria Refs

| Commentary | Ref Builder | Notes |
|---|---|---|
| רש"י | `Rashi_on_${convertRefFormat(ref)}` | Hebrew, `isPrimary: true` |
| רמב"ן | `Ramban_on_${convertRefFormat(ref)}` | Hebrew, `isPrimary: true` |
| הנצי"ב | `Haamek_Davar_on_${convertRefFormat(ref)}` | Hebrew |
| רש"ר הירש | `Rav Hirsch on Torah, ${ref}` | German only (raw ref, no dot-conversion) |

Note: Hirsch uses a different ref format — the book is part of the work 
title, not converted with dots. Example: `Rav Hirsch on Torah, Exodus 27:20-28:12`.

## Files

| File | Action |
|---|---|
| `api/insights.js` | Create — Vercel serverless function |
| `app.js` | Edit — commentary fetchers, Gemini call, DOM injection |
| `style.css` | Edit — `.layer-insights` styles |
| `tasks.md` | Edit — replace Phase 2 task with detailed subtasks |

## API Contract

### `POST /api/insights`

**Request:**
```json
{
  "ref": "Exodus 27:20-28:12",
  "torahVerses": ["verse1 text...", "verse2 text..."],
  "commentaries": {
    "rashi": [["comment on v1", "another comment"], ["comment on v2"]],
    "ramban": [["comment"], []],
    "haamekDavar": [["comment"], []],
    "ravHirsch": [["German text paragraph1", "paragraph2"], []]
  }
}
```

The commentary arrays are indexed by verse position (0-indexed, aligned with torahVerses).
Each verse's commentary is an array of comment strings (a commentator may 
have multiple comments per verse).

**Response:**
```json
{
  "insights": {
    "0": [
      {"commentator": "רש\"י", "insight": "המדרש מלמד ש..."},
      {"commentator": "רמב\"ן", "insight": "לפי הרמב\"ן..."}
    ],
    "3": [
      {"commentator": "הנצי\"ב", "insight": "..."}
    ]
  }
}
```

Only verses with actual פנינים are included. Empty = box hidden.

## Gemini Prompt

**Model:** `gemini-2.0-flash`
**Output:** JSON with `responseSchema` enforced

```
System: You are a Torah scholar with deep expertise in classical Jewish commentary.

User: You will receive:
1. Torah verse texts for an aliyah section
2. Raw commentary text from 4 commentators: Rashi, Ramban, Ha'amek Davar (Netziv), Rav Hirsch (in German)

Your task: Extract only the "פנינים" — the gems — from these commentaries.

Include ONLY insights that contain:
- References to Midrash or Aggadic material
- Moral or ethical lessons (תובנות מוסריות)  
- Novel interpretations or wordplay (חידושים)
- Deep philosophical, theological, or kabbalistic insights
- Connections to other Torah passages that illuminate meaning

SKIP: Simple vocabulary clarifications, grammatical explanations, 
pshat explanations of the plain meaning, historical background that 
doesn't carry a moral lesson.

For Rav Hirsch (German text): translate the insight to Hebrew.
Output language: Hebrew only.
Keep each insight concise: 2-3 sentences maximum.

Return a JSON object where keys are 0-indexed verse numbers (as strings),
and values are arrays of {commentator, insight} objects.
Only include verses that have at least one gem. 
If a verse has no gems from any commentator, omit it entirely.
```

## DOM Structure

New element added to each `.verse-triplet` that has insights:

```html
<div class="layer layer-insights">
  <span class="layer-label">פנינים</span>
  <div class="insight-entry">
    <span class="insight-commentator">רש"י:</span>
    <span class="insight-text">המדרש אומר ש...</span>
  </div>
  <div class="insight-entry">
    <span class="insight-commentator">הנצי"ב:</span>
    <span class="insight-text">לפי הנצי"ב...</span>
  </div>
</div>
```

Text set via `textContent` (not `innerHTML`) — no sanitizer needed.

## Commentary Text Alignment

The Sefaria commentary APIs return text as nested arrays:
- `text[chapter_offset][verse_offset]` = array of comment strings for that verse

The client must flatten these into per-verse arrays aligned with the Torah verses,
using the same `flattenVerses()` logic already in `app.js` — or a new equivalent 
`flattenCommentaryVerses()` that handles the 3-level depth 
(chapter × verse × comment_index).

## Loading Strategy

1. `render()` fetches and renders Mikra/Steinsaltz/Onkelos as today
2. After `containerEl` is populated, call `loadInsights(ref, aliyahRefs, groupEl)` 
   without `await` — fire and forget
3. `loadInsights()` fetches the 4 Sefaria commentaries, calls `/api/insights`, 
   then walks the `.verse-triplet` elements and appends insight boxes
4. Each verse-triplet that has insights gets a fade-in animation on the new box
5. Failures at any step are silent (no UI error shown)

## Security

- API key lives only in Vercel env, never sent to client
- Gemini response is plain text (insights), rendered with `textContent`
- No new `innerHTML` surfaces introduced
- `/api/insights` should validate request body (ref is a string, commentaries is an object)

## Error Handling

| Failure | Behavior |
|---|---|
| Sefaria commentary fetch fails | Send `null` for that commentator; Gemini works with what it has |
| Gemini returns error | `loadInsights()` returns early; no insight boxes shown |
| Gemini returns malformed JSON | Catch parse error; return early |
| Verse index mismatch | Skip that verse silently |
