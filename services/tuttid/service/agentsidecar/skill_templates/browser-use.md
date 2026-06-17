---
name: browser-use
description: Use to operate a web browser — open URLs, read page content, click, fill forms, take screenshots — through the Tutti CLI.
---

# Browser Use

Use this skill whenever the task needs a web browser: visiting a URL, reading
what is on a page, clicking, filling forms, or capturing a screenshot.

Drive the browser **only** through the `tutti browser` CLI. The Tutti daemon owns
the browser session for you. Do **not** shell out to `open`, `xdg-open`, `start`,
`google-chrome`, `chromium`, or any direct browser launch — those are not the
managed browser and will be blocked or denied.

## Commands

- `tutti browser navigate --url <url>` — open a URL; returns the page state.
- `tutti browser snapshot` — accessibility-tree snapshot of the page. Each
  element has a `uid` — use it for click/fill.
- `tutti browser click --uid <uid>` — click an element (uid from `snapshot`).
- `tutti browser fill --uid <uid> --value <text>` — type into a field.
- `tutti browser eval --script '() => document.title'` — run JS on the page and
  return the result.
- `tutti browser screenshot` — save a PNG and return its file path (add
  `--full-page true` for the whole page).
- `tutti browser list-pages` — list open pages.

## Workflow

1. `tutti browser navigate --url <url>`.
2. `tutti browser snapshot` to see the page and the element `uid`s.
3. Act with `click` / `fill` (referencing uids from the latest snapshot), or read
   content with `eval` / `snapshot`.
4. Re-`snapshot` after actions that change the page — uids can change.

## Notes

- The browser session is shared per workspace and reused across commands; you do
  not need to (and cannot) open or close it yourself.
- If a command reports the browser failed to start or Chrome is missing, report
  that to the user rather than falling back to a shell command.
