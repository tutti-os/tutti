---
name: computer-use
description: Use to operate the macOS desktop — take screenshots, click, type, press keys, scroll — through the Tutti CLI.
---

# Computer Use

Use this skill for macOS desktop automation: screenshot, click, type, press keys, scroll, or move the cursor.

Drive the desktop only through `{{CLI_COMMAND}} computer`. The Tutti daemon owns the cua-driver session. Do not use AppleScript, `osascript`, `xdotool`, or direct accessibility APIs; those are outside the managed session.

## Protocol

1. Start with `{{CLI_COMMAND}} computer screenshot` to read screen state.
2. Choose coordinates from that screenshot; coordinates are logical screen points.
3. Act with `click`, `double-click`, `right-click`, `type`, `press-key`, `scroll`, or `move-cursor`.
4. Re-run `screenshot` after actions that change the UI because coordinates can shift.

Common forms:

- `{{CLI_COMMAND}} computer click --x <n> --y <n>`
- `{{CLI_COMMAND}} computer type --text <text>`
- `{{CLI_COMMAND}} computer press-key --key <key>`
- `{{CLI_COMMAND}} computer scroll --x <n> --y <n> --direction <up|down|left|right> --amount <n>`

## Guardrails

- The computer session is shared per workspace and reused across commands.
- Automation is background and should not steal focus.
- If cua-driver is missing or Screen Recording/Accessibility permission is denied, report that error instead of falling back to AppleScript or shell automation.
