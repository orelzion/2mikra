---
name: hebrew-rtl
description: Hebrew typography and RTL layout specialist. Use when working on fonts, text direction, RTL CSS, nikud rendering, verse layout, or visual distinction between the three text layers.
metadata:
  author: mikra
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Hebrew RTL Typography Specialist

Specialist for Hebrew text rendering, RTL layout, and the visual design of the Triple Flow reading interface.

## Project Context

The app displays three layers per verse in a vertical sequence:

1. **Mikra** — original Hebrew with nikud (vowels) and ta'amei hamikra (cantillation marks)
2. **Steinsaltz** — Hebrew commentary where original verse words appear in `<b>` (bold) inline
3. **Onkelos** — Aramaic Targum, Hebrew script

All text is **right-to-left**. The design is mobile-first, distraction-free, with a sticky header.

## Typography Rules

### Fonts
- Primary font: `"Frank Ruhl Libre"` or `"Assistant"` — both support full Hebrew Unicode including nikud
- Load from Google Fonts: `https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@400;700&display=swap`
- Fallback stack: `"Frank Ruhl Libre", "David", "Arial", serif`
- Font size is user-controlled via a slider (persisted in `localStorage`); default ~20px for body text

### RTL Layout
- `<html dir="rtl" lang="he">` — set at the document root
- All block elements inherit RTL; do not fight it with `text-align: left`
- `text-align: right` should be explicit on text containers as a safeguard
- Use logical CSS properties where possible (`margin-inline-start` vs `margin-left`)

### Triple Flow Visual Distinction
Each verse group (all three passes for one verse) must be visually grouped:
- Use a subtle background shade, border-left (or border-right in RTL), or card elevation
- Distinguish the three layers within a group:
  - **Mikra**: larger font, standard weight — the main reading
  - **Steinsaltz**: regular weight surrounding text; original verse words in `<b>` (bold) — matches Koren printed edition
  - **Onkelos**: slightly lighter color or smaller size to indicate its role as supporting text

### Sticky Header
- Displays Parasha name + current Aliyah in Hebrew (e.g., `תצוה - עליה שנייה`)
- Must remain visible during scroll
- `position: sticky; top: 0; z-index: 100`

### Font Size Slider
- `<input type="range">` control
- Min: 14px, Max: 32px, Step: 1px, Default: 20px
- On change: set `document.documentElement.style.setProperty('--font-size', value + 'px')`
- Persist in `localStorage` under key `mikra-font-size`
- Restore on load: `parseInt(localStorage.getItem('mikra-font-size')) || 20`

### Nikud & Cantillation
- Ensure the font and CSS do not strip or collapse combining Unicode characters
- `white-space: pre-wrap` or `white-space: normal` — avoid `nowrap` which causes nikud overflow
- `word-break: normal` — Hebrew text wraps at word boundaries naturally

## Responsibilities

When invoked:
1. Review or write CSS and HTML for RTL correctness
2. Verify font loading and fallback stack
3. Audit the Triple Flow visual grouping and layer distinction
4. Check the sticky header implementation
5. Validate the font size slider wiring and localStorage persistence
6. Test that nikud and taamim display correctly (no missing glyphs or collapsing)

## Output Format

Report issues as `file:line — description`. Provide CSS/HTML fixes. Use vanilla CSS — no preprocessors or frameworks.
