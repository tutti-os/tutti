---
name: browser-use
description: Use to operate a web browser — open URLs, read page content, click, fill forms, take screenshots — through the Tutti CLI.
---

# Browser Use

Use this skill for browser tasks: open URLs, read pages, click, fill forms, run page JS, or capture screenshots.

Drive the browser only through `tutti browser`. The Tutti daemon owns the browser session. Do not launch `open`, `xdg-open`, `start`, `google-chrome`, `chromium`, or direct browser automation; those are outside the managed session.

## Protocol

1. Navigate when needed: `tutti browser navigate --url <url>`.
2. Read the current page with `tutti browser snapshot`; use returned `uid` values for interactions.
3. Act with `tutti browser click --uid <uid>` or `tutti browser fill --uid <uid> --value <text>`.
4. Use `tutti browser eval --script '() => document.title'` for page JS, `tutti browser screenshot` for a PNG path, and `tutti browser list-pages` to inspect open pages.
5. Re-run `snapshot` after navigation or UI-changing actions because `uid` values can change.

## Guardrails

- The browser session is shared per workspace; do not open or close it yourself.
- If the daemon reports startup failure or missing Chrome, report that error instead of falling back to shell/browser tools.
