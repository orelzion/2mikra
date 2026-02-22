This PRD is tailored for your specific needs as a developer and a learner, focusing on the "Triple Flow" (Mikra-Steinsaltz-Onkelos) with a mobile-first, PWA approach.
PRD: "Shnayim Mikra" Interactive Web App
1. Project Overview

A focused, high-performance Progressive Web App (PWA) designed to facilitate the daily study of the weekly Torah portion (Parashat Hashavua) following the "Shnayim Mikra ve-Echad Targum" tradition. The app uniquely substitutes the second "Mikra" reading with the Steinsaltz (Hebrew) explanation for enhanced comprehension.

**Tech Stack:** Vanilla HTML/CSS/JS — no framework, no build step. Lightweight and easy to maintain for a solo developer.

2. Core Experience (The "Triple Flow")

For every verse in the daily Aliyah, the interface will display three layers in a vertical sequence:

    First Pass (Mikra): Original Hebrew text with Nikud and Ta'amei Hamikra.

    Second Pass (Explanation): The Steinsaltz Hebrew commentary (integrated text). The Steinsaltz text includes the original verse words inline (wrapped in `<b>` tags by the API). These must render as **bold** to visually distinguish them from the surrounding explanation text (regular weight). This matches the Koren printed edition style and allows the user to follow along with the actual verse while reading the explanation.

    Third Pass (Targum): Targum Onkelos.

3. Functional Requirements
3.1 Smart Date & Location Logic

    Timezone Locking: All date calculations must be hardcoded to Asia/Jerusalem to ensure the correct Parasha is displayed regardless of the user's physical location. Day boundaries use **midnight-based calendar dates** (not halachic sunset).

    Daily Aliyah Mapping:

        Sun - Thu: Display only the Aliyah corresponding to that day (e.g., Sunday = 1st Aliyah).

        Friday: Display the 6th and 7th Aliyot to complete the Parasha. (Maftir is excluded for MVP.)

        Saturday: Display a "Shabbat Shalom" rest message indicating the weekly reading is complete.

3.2 Sefaria API Integration

    Calendar Fetch: Retrieve the weekly metadata from `GET https://www.sefaria.org/api/calendars`. The Parashat Hashavua entry contains an `extraDetails.aliyot` array.

    Dynamic Aliyah Selection: Extract the specific `ref` from the `extraDetails.aliyot` array based on the current day index.

    Content Fetch: Three separate parallel API calls per Aliyah are required:
        1. **Torah text (Mikra):** `GET /api/v3/texts/{ref}` — e.g., `/api/v3/texts/Exodus.27.20-28.12`
        2. **Steinsaltz commentary:** `GET /api/v3/texts/Steinsaltz_on_{book}.{chapter}.{verse_start}-{verse_end}` — e.g., `/api/v3/texts/Steinsaltz_on_Exodus.27.20-28.12`
        3. **Targum Onkelos:** `GET /api/v3/texts/Onkelos_{book}.{chapter}.{verse_start}-{verse_end}` — e.g., `/api/v3/texts/Onkelos_Exodus.27.20-28.12`

    Note: The `ref` from the calendar API uses a format like `"Exodus 27:20-28:12"` which must be converted to the URL path format `Exodus.27.20-28.12` (spaces to dots, colons to dots, hyphens preserved between verse ranges).

    Double Parashiyot: Trust the Sefaria calendar API data as-is — no special handling needed. The aliyot array will reflect the combined reading.

3.3 PWA Capabilities (High Priority)

    Offline Access: Implement Service Workers to cache the current week's text so users can study without an active internet connection (e.g., in a synagogue).

    Mobile Install: Provide a manifest.json for "Add to Home Screen" support with a standalone window experience.

4. Technical Specifications
4.1 Data Mapping

Based on the Sefaria JSON structure:

    1st Aliyah: extraDetails.aliyot[0]

    2nd Aliyah: extraDetails.aliyot[1]

    ...and so on.

    Friday Logic: Iterate through aliyot[5] and aliyot[6] only. Maftir (aliyot[7]) is excluded for MVP.

4.2 Content Parsing

    Steinsaltz Styling: The Steinsaltz API response includes HTML `<b>` tags wrapping the original verse words. These must render as **bold text** so the user can clearly see what is the original verse vs. the explanation. The commentary text surrounding the bold words renders in regular font weight.

    Text Alignment: Right-to-Left (RTL) layout with a focus on typography (e.g., "Frank Ruhl Libre" or "Assistant" fonts).

4.3 API Response Structure

    Torah text versions array → use the version with `versionTitle: "Miqra according to the Masorah"` (or `"Tanach with Ta'amei Hamikra"`) for full nikud + taamim.

    Steinsaltz → single version from `"The Koren Steinsaltz Tanakh HaMevoar - Hebrew"`.

    Onkelos → use the version from `"Sifsei Chachomim Chumash, Metsudah Publications, 2009"` (has interpretive highlighting) or `"Onkelos Exodus"` (plain).

5. UI/UX Requirements

    Clean View: No distractions. Only the current day's verses.

    Sticky Header: Display the Parasha name and the current Aliyah (e.g., "תצוה - עליה שנייה").

    Font Controls: A continuous **slider** for font size adjustment, providing fine-grained control for readability on small screens. Persist the user's preference in localStorage.

    Visual Distinction: Subtle background shading or borders to group the three passes of a single verse together.

6. Roadmap
Phase 1: MVP (Current Focus)

    Integration with Sefaria Calendar and Text APIs (3 parallel calls per Aliyah).

    Daily Aliyah logic (Jerusalem midnight-based calendar dates).

    PWA Manifest and Service Worker setup.

    RTL UI implementation.

    Font size slider with localStorage persistence.

    Saturday rest screen.

Phase 2: AI Enhancements

    Gemini Integration: An "Insights" button at the end of each Aliyah that uses Gemini to generate a 3-sentence summary of the main commentators (Rashi, Ramban, Ibn Ezra) for that specific section.

Phase 3: Personalization

    "Last Read" markers.

    Dark Mode support.

    Maftir support on Fridays.

    Toggle between traditional mode (Mikra x2 + Targum) and enhanced mode (Mikra + Steinsaltz + Targum).
