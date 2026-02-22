# Pre-commit Security Hook Design

**Date:** 2026-02-22  
**Status:** Approved

## Summary

Add a `.git/hooks/pre-commit` shell script that runs the Claude Code security agent on every staged `.js` and `.html` file before a commit is accepted. Commits with `[HIGH]` severity findings are blocked; `[MEDIUM]` and `[LOW]` findings are shown as warnings but do not block.

## Context

- Project: Mikra PWA — vanilla HTML/CSS/JS, no build toolchain
- Security skill lives at `.agents/skills/security/SKILL.md`
- Security threat model: XSS via innerHTML, CSP misconfiguration, Service Worker scope, localStorage misuse
- No existing hook framework (no husky, no npm)

## Design

### Storage

Local only — `.git/hooks/pre-commit`. Not tracked in git (solo project).

### Invocation

Uses `claude --print -p "<prompt>"` for non-interactive, stdout-captured output.

### Flow

```
git commit
  └─ pre-commit hook runs
       ├─ collect staged .js/.html files via git diff --cached --name-only
       ├─ if none: skip (exit 0)
       ├─ invoke: claude --print -p "Security review of <files>..."
       ├─ capture output
       ├─ grep for [HIGH]
       │    ├─ found → print report, exit 1 (BLOCK commit)
       │    └─ not found → print summary, exit 0 (ALLOW commit)
```

### Severity Policy

| Severity | Action          |
|----------|-----------------|
| HIGH     | Block commit    |
| MEDIUM   | Warn, allow     |
| LOW      | Warn, allow     |
| None     | Allow silently  |

### Prompt Template

```
You are a security reviewer for the Mikra PWA project.
Review the following staged files for security issues using the rules in .agents/skills/security/SKILL.md.
Focus on: XSS via innerHTML, missing CSP, eval/document.write usage, unsafe localStorage reads, Service Worker scope issues.
Report findings as: file:line — [SEVERITY] description
Severities: HIGH, MEDIUM, LOW.
Files to review: <staged files list>
```

## Constraints

- Hook must work without Node.js, Python, or any build tool
- Must handle the case where `claude` CLI is not installed (fail gracefully with a warning, not a block)
- Must skip binary files and non-JS/HTML files silently
