# Mikra — MVP Task List

Tasks derived from the PRD. Each task lists the responsible agent skill.

---

## Phase 1: MVP

### 1. Project Scaffold
**Agent:** *(no specialist — general setup)*
- [ ] Create `index.html` with `<html dir="rtl" lang="he">`, meta tags, font link, and script/style references
- [ ] Create `style.css` (empty shell)
- [ ] Create `app.js` (empty shell)
- [ ] Add `<link rel="manifest" href="manifest.json">` to `index.html`

---

### 2. Sefaria API Integration
**Agent:** `sefaria-api`
- [ ] Fetch the weekly calendar from `GET https://www.sefaria.org/api/calendars`
- [ ] Locate the `"Parashat Hashavua"` entry and extract `extraDetails.aliyot`
- [ ] Implement ref format conversion: `"Exodus 27:20-28:12"` → `Exodus.27.20-28.12`
- [ ] Build Steinsaltz ref: `Steinsaltz_on_{ref}`
- [ ] Build Onkelos ref: `Onkelos_{ref}`
- [ ] Run three parallel `fetch` calls per Aliyah using `Promise.all`
- [ ] Parse and select the correct version from each API response:
  - Torah: `"Miqra according to the Masorah"` or `"Tanach with Ta'amei Hamikra"`
  - Steinsaltz: `"The Koren Steinsaltz Tanakh HaMevoar - Hebrew"`
  - Onkelos: `"Sifsei Chachomim Chumash, Metsudah Publications, 2009"` or `"Onkelos Exodus"`
- [ ] Handle API errors gracefully (no stack traces in UI)

---

### 3. Date & Aliyah Selection Logic
**Agent:** `date-logic`
- [ ] Implement `getJerusalemDate()` using `Intl.DateTimeFormat` locked to `Asia/Jerusalem`
- [ ] Implement `DAY_TO_ALIYAH` mapping (Sun=0 … Thu=4, Fri=[5,6], Sat=null)
- [ ] Wire day index to the correct Aliyah `ref` from `extraDetails.aliyot`
- [ ] Friday: fetch and render both `aliyot[5]` and `aliyot[6]` (Maftir excluded)
- [ ] Saturday: skip API call; render "Shabbat Shalom" rest screen

---

### 4. Triple Flow UI — RTL & Hebrew Typography
**Agent:** `hebrew-rtl`
- [ ] Set `<html dir="rtl" lang="he">` at document root
- [ ] Load `"Frank Ruhl Libre"` (wght 400 & 700) from Google Fonts; set fallback stack
- [ ] Implement CSS variable `--font-size` used by all text containers
- [ ] Style each verse group with subtle background/border to visually group the three passes
- [ ] Style the three layers within a verse group:
  - **Mikra**: larger font, standard weight
  - **Steinsaltz**: regular weight; original verse words in `<b>` render bold (matches Koren edition)
  - **Onkelos**: slightly lighter color or smaller size
- [ ] Implement sticky header (`position: sticky; top: 0`) showing Parasha name + Aliyah in Hebrew
- [ ] Implement font size slider (`<input type="range">` min 14, max 32, step 1, default 20)
- [ ] Wire slider to `--font-size` CSS variable and persist in `localStorage` under key `mikra-font-size`
- [ ] Restore font size from `localStorage` on page load

---

### 5. PWA — Manifest & Service Worker
**Agent:** `pwa-offline`
- [ ] Create `manifest.json` with `display: standalone`, `dir: rtl`, `lang: he`, name, short_name, theme/background colors, and 192×192 + 512×512 icons
- [ ] Create `sw.js` with versioned cache name (e.g., `mikra-v1`)
- [ ] Cache app shell (Cache-first): `index.html`, `style.css`, `app.js`, fonts
- [ ] Cache Sefaria API responses (Network-first, cache fallback) for all week's aliyot
- [ ] Invalidate and delete old caches on `activate`
- [ ] Register Service Worker in `app.js` (check `'serviceWorker' in navigator`)
- [ ] Validate offline fallback displays cached content gracefully

---

### 6. Security Audit
**Agent:** `security`
- [ ] Add Content Security Policy `<meta>` tag (no `unsafe-inline`/`unsafe-eval`)
- [ ] Steinsaltz rendering: use DOMPurify (allowlist `<b>` only) before any `innerHTML` call
- [ ] Mikra and Onkelos text: use `textContent` (never raw `innerHTML`)
- [ ] Validate `localStorage` font-size on read: `parseFloat`, clamped to [14, 32]
- [ ] Service Worker: scope limited to `'/'`, no caching of 4xx/5xx responses
- [ ] Remove any `console.log` of API responses before production deploy
- [ ] Audit for `eval`, `new Function`, or `document.write` usage

---

### 7. UI/UX Review
**Agent:** `web-design-guidelines`
- [ ] Review `index.html` and `style.css` against Web Interface Guidelines
- [ ] Check accessibility (ARIA roles, contrast, keyboard navigation)
- [ ] Verify mobile-first responsive layout

---

## Phase 2 (Future — not MVP)

- [ ] Gemini "Insights" button per Aliyah (3-sentence summary of Rashi, Ramban, Ibn Ezra)

---

## Phase 3 (Future — not MVP)

- [ ] "Last Read" markers
- [ ] Dark Mode support
- [ ] Maftir support on Fridays
- [ ] Toggle: traditional mode (Mikra x2 + Targum) vs enhanced mode (Mikra + Steinsaltz + Targum)
