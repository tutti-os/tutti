---
name: computer-use
description: Use to operate the macOS desktop — take screenshots, click, type, press keys, scroll — through the Tutti CLI.
---

# Computer Use

Use this skill for macOS desktop automation: screenshot, click, type, press keys, scroll, or move the cursor.

Drive the desktop only through `{{CLI_COMMAND}} computer`. The Tutti daemon owns the cua-driver session. Do not use AppleScript, `osascript`, `xdotool`, direct accessibility APIs, or the standalone cua-driver CLI; those are outside the managed session.

## Stable Window Workflow

Stable commands implement a window-coordinate workflow. They do not have a shared `--scope` flag.

1. Start with `{{CLI_COMMAND}} computer screenshot --json`. Prefer an explicit `--pid <pid> --window-id <window-id>` pair; omit both only when automatic visible-window selection is intentional.
2. Choose `click`, `double-click`, `right-click`, and `scroll` coordinates from that window screenshot. Coordinates are local to its image, so reuse the same explicit pid/window pair for the action.
3. Act with `click`, `double-click`, `right-click`, `type`, `press-key`, or `scroll`. Re-run `screenshot` after actions that change the UI because coordinates can shift.
4. `move-cursor` is scope-less. Its coordinates are agent-cursor screen points, not pixels from a window or desktop screenshot.

Common forms:

- `{{CLI_COMMAND}} computer screenshot --pid <pid> --window-id <window-id> --json`
- `{{CLI_COMMAND}} computer click --pid <pid> --window-id <window-id> --x <n> --y <n>`
- `{{CLI_COMMAND}} computer type --pid <pid> --window-id <window-id> --text <text>`
- `{{CLI_COMMAND}} computer press-key --pid <pid> --window-id <window-id> --key <key>`
- `{{CLI_COMMAND}} computer scroll --pid <pid> --window-id <window-id> --x <n> --y <n> --direction <up|down|left|right> --amount <n>`
- `{{CLI_COMMAND}} computer move-cursor --x <screen-point-x> --y <screen-point-y>`

## Native Driver Capabilities

The native tool surface is the complete entry point for authorized cua-driver capabilities that have no stable alias. Discover the live contract instead of guessing arguments or assuming that different tools share a scope model:

1. Run `{{CLI_COMMAND}} computer tool list --json`.
2. Run `{{CLI_COMMAND}} computer tool describe --name <tool> --json` and follow its returned `inputSchema`.
3. Run `{{CLI_COMMAND}} computer tool call --name <tool> --arguments-json '<object>' --json`.

### Desktop workflow

Desktop capture and input are not one uniform scope:

1. When the user asks to inspect the screen, desktop, or entire display rather than a specific app window, use this desktop workflow instead of the stable `screenshot` command. Inspect `get_config`, then read the persisted driver configuration:

   `{{CLI_COMMAND}} computer tool describe --name get_config --json`

   `{{CLI_COMMAND}} computer tool call --name get_config --arguments-json '{}' --json`

2. `get_desktop_state` works only when the host-global persisted `capture_scope` is `desktop`. If it is not enabled, describe the allowed `set_config` tool and change it through the managed native surface:

   `{{CLI_COMMAND}} computer tool describe --name set_config --json`

   `{{CLI_COMMAND}} computer tool call --name set_config --arguments-json '{"capture_scope":"desktop"}' --json`

   This setting persists globally in cua-driver. Do not hide the mutation inside a set/call/restore sequence, and do not restore it automatically after capture. Re-read `get_config` if the result does not clearly confirm the new value.

3. Describe and call `get_desktop_state` using its live schema:

   `{{CLI_COMMAND}} computer tool describe --name get_desktop_state --json`

   `{{CLI_COMMAND}} computer tool call --name get_desktop_state --arguments-json '{"screenshot_out_file":"/tmp/desktop.png"}' --json`

4. The native `click` tool has its own per-call desktop contract. Confirm its live schema, then call it directly:

   `{{CLI_COMMAND}} computer tool describe --name click --json`

   `{{CLI_COMMAND}} computer tool call --name click --arguments-json '{"scope":"desktop","x":1200,"y":700}' --json`

   Do not infer that contract for other tools.

5. Desktop scrolling is not supported by the current driver contract: native `scroll` requires a PID and has no true desktop-coordinate mode. Use the stable window workflow when scrolling.

## Guardrails

- The Tutti computer session is shared per workspace and reused across commands. cua-driver's persisted `capture_scope` is broader global state and is never a hidden per-call switch. Native `set_config` may change it explicitly when the requested workflow requires desktop capture.
- Prefer explicit `--pid <pid> --window-id <window-id>` for stable window commands. Omit both only when automatic visible-window selection is intentional.
- Native `tool list` and `tool describe` preserve the live catalog and show Tutti's `allowed` and `denialReason` decision. `tool call` enforces that decision; never try to invoke an entry with `allowed: false`.
- If cua-driver is missing or Screen Recording/Accessibility permission is denied, report that error instead of falling back to AppleScript or shell automation.
