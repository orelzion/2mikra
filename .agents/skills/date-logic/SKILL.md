---
name: date-logic
description: Jerusalem timezone and daily Aliyah logic specialist. Use when working on date calculations, day-of-week mapping, aliyah selection, Shabbat detection, or Friday double-aliyah logic.
metadata:
  author: mikra
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Date Logic & Aliyah Selection Specialist

Specialist for the timezone-aware date logic that determines which Aliyah to display each day.

## Project Context

The app must display the correct daily Aliyah regardless of the user's physical location. All date calculations are locked to **Asia/Jerusalem** timezone using **midnight-based calendar dates** (not halachic sunset).

## Daily Aliyah Mapping

| Day (Jerusalem) | Aliyah to display |
|---|---|
| Sunday | `aliyot[0]` — 1st Aliyah |
| Monday | `aliyot[1]` — 2nd Aliyah |
| Tuesday | `aliyot[2]` — 3rd Aliyah |
| Wednesday | `aliyot[3]` — 4th Aliyah |
| Thursday | `aliyot[4]` — 5th Aliyah |
| Friday | `aliyot[5]` + `aliyot[6]` — 6th & 7th Aliyot (Maftir excluded) |
| Saturday | Show "Shabbat Shalom" rest screen — no Aliyah content |

`aliyot` is the `extraDetails.aliyot` array from the Sefaria calendar API response for the `"Parashat Hashavua"` entry.

## Jerusalem Timezone Logic

Use the `Intl.DateTimeFormat` API to get the current date in Jerusalem:

```js
function getJerusalemDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
```

Map `weekday` string to `aliyot` index:
```js
const DAY_TO_ALIYAH = {
  Sunday: 0, Monday: 1, Tuesday: 2,
  Wednesday: 3, Thursday: 4, Friday: [5, 6], Saturday: null
};
```

Return `null` for Saturday to trigger the Shabbat screen.

## Edge Cases

- **Double Parashiyot:** Trust the Sefaria calendar API as-is. The `aliyot` array will reflect the combined reading — no special handling needed.
- **Holidays:** The calendar API may return a different entry; no special handling required for MVP.
- **Friday midnight boundary:** Use midnight (00:00:00 Jerusalem time) as the day boundary, not sunset.

## Responsibilities

When invoked:
1. Review or write the date/aliyah selection logic in the specified file(s)
2. Verify Jerusalem timezone is hardcoded using `Intl.DateTimeFormat` with `timeZone: 'Asia/Jerusalem'`
3. Confirm the day-to-aliyah index mapping matches the table above
4. Ensure Friday correctly returns two aliyot (`[5]` and `[6]`)
5. Ensure Saturday returns the Shabbat rest screen with no API call
6. Validate no logic depends on the user's local system timezone

## Output Format

Report issues as `file:line — description`. Provide fixes in vanilla JS (no framework, no build step).
