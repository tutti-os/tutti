---
name: browser-use
description: Use to operate a web browser — open URLs, read page content, click, fill forms, take screenshots — through the Tutti CLI.
---

# Browser Use

Use this skill for browser tasks: open URLs, read pages, click, fill forms, run page JS, or capture screenshots.

Drive the browser only through `{{.CLICommand}} browser`. The Tutti daemon owns the browser session. Do not launch `open`, `xdg-open`, `start`, `google-chrome`, `chromium`, or direct browser automation; those are outside the managed session.

## Protocol

1. Navigate when needed: `{{command "browser.navigate" (args "url" "<url>")}}`.
2. Read the current page with `{{command "browser.snapshot"}}`; use returned `uid` values for interactions.
3. Act with `{{command "browser.click" (args "uid" "<uid>")}}` or `{{command "browser.fill" (args "uid" "<uid>" "value" "<text>")}}`.
4. Use `{{command "browser.list-pages"}}` to inspect the User Browser and your Agent Browser tabs. Select a stable target with `{{command "browser.select-page" (args "page-id" "<id>")}}` when needed.
5. Create an Agent Browser tab with `{{command "browser.new-page" (args "url" "<url>")}}` and close a page you own with `{{command "browser.close-page" (args "page-id" "<id>")}}`.
6. Use `{{command "browser.eval" (args "script" "'() => document.title'")}}` for page JS and `{{command "browser.screenshot"}}` for a PNG path.
7. Re-run `snapshot` after navigation or UI-changing actions because `uid` values can change.

## Guardrails

- The desktop browser session includes visible in-app BrowserNode tabs for the current workspace. Website App tabs are outside this automation scope.
- User Browser tabs may contain the user's active work. Read or modify them only when that is required by the request.
- If the desktop BrowserNode host or the headless managed Chrome backend is unavailable, report that error instead of falling back to shell/browser tools.
