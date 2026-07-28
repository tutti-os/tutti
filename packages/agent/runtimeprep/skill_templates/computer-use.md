---
name: computer-use
description: Use to operate the macOS desktop — take screenshots, click, type, press keys, scroll — through the Tutti CLI.
---

# Computer Use

Use this skill for macOS desktop automation: screenshot, click, type, press keys, scroll, or move the cursor.

Drive the desktop only through `{{.CLICommand}} computer`. The Tutti daemon owns the cua-driver session. Do not use AppleScript, `osascript`, `xdotool`, direct accessibility APIs, or the standalone cua-driver CLI; those are outside the managed session.

## Stable Window Workflow

Stable commands implement a window-coordinate workflow. They do not have a shared `--scope` flag.

1. Start with `{{command "computer.screenshot"}}`. Prefer an explicit `--pid <pid> --window-id <window-id>` pair; omit both only when automatic visible-window selection is intentional.
2. Choose `click`, `double-click`, `right-click`, and `scroll` coordinates from that window screenshot. Coordinates are local to its image, so reuse the same explicit pid/window pair for the action.
3. Act with `click`, `double-click`, `right-click`, `type`, `press-key`, or `scroll`. Re-run `screenshot` after actions that change the UI because coordinates can shift.
4. `move-cursor` is scope-less. Its coordinates are agent-cursor screen points, not pixels from a window or desktop screenshot.

Common forms:

- `{{command "computer.screenshot" (args "pid" "<pid>" "window-id" "<window-id>")}}`
- `{{command "computer.click" (args "pid" "<pid>" "window-id" "<window-id>" "x" "<n>" "y" "<n>")}}`
- `{{command "computer.type" (args "pid" "<pid>" "window-id" "<window-id>" "text" "<text>")}}`
- `{{command "computer.press-key" (args "pid" "<pid>" "window-id" "<window-id>" "key" "<key>")}}`
- `{{command "computer.scroll" (args "pid" "<pid>" "window-id" "<window-id>" "x" "<n>" "y" "<n>" "direction" "<up|down|left|right>" "amount" "<n>")}}`
- `{{command "computer.move-cursor" (args "x" "<screen-point-x>" "y" "<screen-point-y>")}}`

## Click Reliability

Pixel clicks are posted as background CGEvents and are never driver-verified: a `✅ Posted click` result only confirms dispatch, not effect. Electron-based apps (Discord, Feishu, VS Code) frequently drop background synthetic clicks entirely.

1. Prefer element actions over pixel coordinates. Structured screenshot content can list interactive elements with an `element_token`; click through the native tool with that token:

   `{{command "computer.tool.call" (args "name" "click" "arguments-json" "'{\"pid\":<pid>,\"element_token\":\"<token>\"}'")}}`

2. Verify every click with a fresh `screenshot` of the target window. The blue agent cursor is a visual overlay on a separate channel — after a display-configuration change it can render at a fixed offset from the true event point, so its on-screen position is not evidence of where a click landed.

3. If a background pixel click produced no visible change, do not re-click the same coordinates. Escalate delivery through the native `click` schema with `"delivery_mode":"foreground"` (briefly fronts the target window), or switch to the element-token path above.

## Native Driver Capabilities

The native tool surface is the complete entry point for authorized cua-driver capabilities that have no stable alias. Discover the live contract instead of guessing arguments or assuming that different tools share a scope model:

1. Run `{{command "computer.tool.list"}}`.
2. Run `{{command "computer.tool.describe" (args "name" "<tool>")}}` and follow its returned `inputSchema`.
3. Run `{{command "computer.tool.call" (args "name" "<tool>" "arguments-json" "'<object>'")}}`.

### Desktop workflow

Desktop capture and input are not one uniform scope:

1. When the user asks to inspect the screen, desktop, or entire display rather than a specific app window, use this desktop workflow instead of the stable `screenshot` command. Inspect `get_config`, then read the persisted driver configuration:

   `{{command "computer.tool.describe" (args "name" "get_config")}}`

   `{{command "computer.tool.call" (args "name" "get_config" "arguments-json" "'{}'")}}`

2. `get_desktop_state` works only when the host-global persisted `capture_scope` is `desktop`. If it is not enabled, describe the allowed `set_config` tool and change it through the managed native surface:

   `{{command "computer.tool.describe" (args "name" "set_config")}}`

   `{{command "computer.tool.call" (args "name" "set_config" "arguments-json" "'{\"capture_scope\":\"desktop\"}'")}}`

   This setting persists globally in cua-driver. Do not hide the mutation inside a set/call/restore sequence, and do not restore it automatically after capture. Re-read `get_config` if the result does not clearly confirm the new value.

3. Describe and call `get_desktop_state` using its live schema:

   `{{command "computer.tool.describe" (args "name" "get_desktop_state")}}`

   `{{command "computer.tool.call" (args "name" "get_desktop_state" "arguments-json" "'{\"screenshot_out_file\":\"/tmp/desktop.png\"}'")}}`

4. The native `click` tool has its own per-call desktop contract. Confirm its live schema, then call it directly:

   `{{command "computer.tool.describe" (args "name" "click")}}`

   `{{command "computer.tool.call" (args "name" "click" "arguments-json" "'{\"scope\":\"desktop\",\"x\":1200,\"y\":700}'")}}`

   Do not infer that contract for other tools.

5. Desktop scrolling is not supported by the current driver contract: native `scroll` requires a PID and has no true desktop-coordinate mode. Use the stable window workflow when scrolling.

## Guardrails

- The Tutti computer session is shared per workspace and reused across commands. cua-driver's persisted `capture_scope` is broader global state and is never a hidden per-call switch. Native `set_config` may change it explicitly when the requested workflow requires desktop capture.
- Prefer explicit `--pid <pid> --window-id <window-id>` for stable window commands. Omit both only when automatic visible-window selection is intentional.
- Native `tool list` and `tool describe` preserve the live catalog and show Tutti's `allowed` and `denialReason` decision. `tool call` enforces that decision; never try to invoke an entry with `allowed: false`.
- If cua-driver is missing or Screen Recording/Accessibility permission is denied, report that error instead of falling back to AppleScript or shell automation.
