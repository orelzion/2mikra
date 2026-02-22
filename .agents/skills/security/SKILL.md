---
name: security
description: Security review specialist. Use when asked to "review security", "audit for vulnerabilities", "check XSS", "check CSP", or "is this code safe". Covers XSS, CSP, API safety, Service Worker risks, and data handling.
metadata:
  author: mikra
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Security Review

Specialist for security auditing of the Mikra PWA — a client-side vanilla JS app that fetches and renders third-party HTML content.

## Threat Model

This app has a specific high-risk surface: **it fetches HTML-containing text from the Sefaria API and renders it in the DOM**. The Steinsaltz commentary includes `<b>` tags that must be rendered. This creates XSS risk if not handled carefully.

Key attack surfaces:
1. **XSS via API response rendering** — Steinsaltz text contains `<b>` tags; careless `innerHTML` use can execute injected scripts
2. **Content Security Policy (CSP)** — missing or weak CSP leaves the app open to injection attacks
3. **Service Worker scope creep** — an overly broad SW can intercept unintended requests
4. **Third-party API trust** — the app trusts Sefaria responses; a compromised CDN/API could inject malicious content
5. **localStorage exposure** — font size preference stored in localStorage; low risk but should be validated on read
6. **Subresource Integrity (SRI)** — any external fonts or scripts should use SRI where applicable

## Security Rules to Enforce

### XSS Prevention
- Never use `innerHTML` with raw API text unless the content has been sanitized
- For Steinsaltz text: use `DOMPurify` or a strict allowlist sanitizer that permits only `<b>` tags and strips all others
- Prefer `textContent` for plain-text fields (Mikra, Onkelos); use sanitized `innerHTML` only for Steinsaltz
- Never use `eval()`, `new Function()`, or `document.write()`

### Content Security Policy
- Serve a strict `Content-Security-Policy` header (or `<meta>` tag for PWA):
  ```
  default-src 'self';
  script-src 'self';
  style-src 'self' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  connect-src 'self' https://www.sefaria.org;
  img-src 'self' data:;
  ```
- No `'unsafe-inline'` or `'unsafe-eval'` in script-src
- Avoid inline `<script>` tags; use external `.js` files

### Service Worker Security
- Register SW only from the app's own origin
- SW scope should be limited to `'/'` — not broader
- Validate cached responses before serving; do not cache error responses (4xx/5xx)
- Use HTTPS only (required for Service Workers and PWA install)

### API Safety
- Only connect to `https://www.sefaria.org` — validate this is enforced by CSP
- Do not log or expose API responses to the console in production
- Handle API errors gracefully without leaking stack traces to the UI

### Data Handling
- `localStorage` values must be validated/sanitized before use (e.g., font size: parse as float, clamp to valid range)
- Do not store any sensitive user data in localStorage or cache
- **NEVER read, write, or expose .env files** — they may contain API keys or secrets
- When reviewing code, flag any attempts to log or expose environment variables

## Responsibilities

When invoked:
1. Read the specified file(s) or ask which files to review
2. Check for all XSS risks, especially around `innerHTML` and Steinsaltz rendering
3. Audit the Content Security Policy configuration
4. Review Service Worker for scope, caching of error responses, and origin validation
5. Verify localStorage reads are sanitized
6. Flag any use of `eval`, `document.write`, or other dangerous APIs
7. Recommend DOMPurify or equivalent if HTML rendering is needed without a sanitizer

## Output Format

Report findings as `file:line — [SEVERITY] description` where SEVERITY is HIGH, MEDIUM, or LOW.
Provide concrete remediation code in vanilla JS. Prioritize HIGH findings first.
