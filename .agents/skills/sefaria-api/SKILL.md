---
name: sefaria-api
description: Sefaria API integration specialist. Use when working on API calls, ref format conversion, response parsing, version selection, parallel fetches, or Sefaria data structures.
metadata:
  author: mikra
  version: "1.0.0"
  argument-hint: <file-or-issue>
---

# Sefaria API Integration

Specialist for all Sefaria API calls, response parsing, and data wrangling in the Mikra app.

## Project Context

The app makes three parallel API calls per Aliyah:

1. **Torah (Mikra):** `GET https://www.sefaria.org/api/v3/texts/{ref}`
   - Target version: `"Miqra according to the Masorah"` (or `"Tanach with Ta'amei Hamikra"`) — full nikud + taamim
2. **Steinsaltz:** `GET https://www.sefaria.org/api/v3/texts/Steinsaltz_on_{ref}`
   - Target version: `"The Koren Steinsaltz Tanakh HaMevoar - Hebrew"`
   - Response includes `<b>` tags wrapping original verse words — must render as bold
3. **Targum Onkelos:** `GET https://www.sefaria.org/api/v3/texts/Onkelos_{ref}`
   - Target version: `"Sifsei Chachomim Chumash, Metsudah Publications, 2009"` or `"Onkelos Exodus"`

**Calendar endpoint:** `GET https://www.sefaria.org/api/calendars`
- Locate the `"Parashat Hashavua"` entry
- Read `extraDetails.aliyot` array (0-indexed; aliyot[5] + aliyot[6] for Friday)

## Ref Format Conversion

The calendar API returns refs like: `"Exodus 27:20-28:12"`

Convert to URL path format: `Exodus.27.20-28.12`
- Spaces → dots
- Colons → dots
- Hyphens preserved between verse ranges

Build Steinsaltz ref: `Steinsaltz_on_Exodus.27.20-28.12`
Build Onkelos ref: `Onkelos_Exodus.27.20-28.12`

## Responsibilities

When invoked:
1. Review or write the Sefaria fetch code in the specified file(s)
2. Verify ref conversion logic handles edge cases (multi-chapter ranges, double parashiyot)
3. Verify version selection from the `versions` array in the API response
4. Ensure all three fetches run in parallel (`Promise.all`)
5. Validate `<b>` tag rendering for Steinsaltz output
6. Check error handling for failed or empty API responses
7. Trust the Sefaria calendar data as-is — no special handling for double parashiyot

## Output Format

Report issues as `file:line — description`. Suggest concrete fixes with code snippets in vanilla JS (no framework, no build step).
