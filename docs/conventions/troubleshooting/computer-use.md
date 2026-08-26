# Computer Use Troubleshooting

Use this guide for recurring cua-driver and `tutti computer` failures. Keep
stable CLI and authorization contracts in
[Tutti CLI Contract](../tutti-cli-contract.md); keep symptom-driven diagnosis
and recovery here.

## Computer use keeps reopening setup after installation or authorization

### Symptom

The Desktop settings row reports that computer use is installed and authorized,
but selecting `/computer` opens setup again. On macOS, the first visit to a
Privacy & Security pane may not list CuaDriver, or Screen Recording may remain
granted but not effective until the driver is restarted.

### Root cause and fix

Desktop permission status and Agent Composer options refresh independently. A
fresh host probe may therefore be authorized while an older Composer snapshot
still reports computer use as unavailable. Treat the fresh installed and
authorized host status as sufficient for the Composer interaction; the daemon
still performs its authoritative readiness clamp when the session launches.

On macOS, start the user-initiated permission grant before opening System
Settings so TCC has registered CuaDriver on the first visit. After both
Accessibility and Screen Recording are granted but capture is not yet
effective, restart CuaDriver through its app bundle and then read status again;
plain polling cannot clear the process-cached permission state.

### Validation

- An uninstalled driver still routes `/computer` to setup.
- An installed and authorized driver inserts and submits `/computer` without
  reopening setup, even if Composer options were loaded before authorization.
- CuaDriver appears on the first user-initiated visit to each macOS permission
  pane.
- Returning from macOS System Settings reconciles granted permissions and
  capture readiness without restarting Tutti.
- Windows continues to use `doctor --json`; macOS-only reconciliation never
  runs on Windows.

## CuaDriver permissions are granted but every input tool is denied

### Symptom

macOS Accessibility and Screen Recording are both granted. Window listing,
screenshots, and the AX tree work, but native `click`, `move_cursor`,
`press_key`, `type_text`, and `scroll` appear with `allowed: false`. Their
denial reason is `tool has denied or unknown capabilities:
input.delivery_mode`.

### Root cause and fix

CuaDriver 0.20 adds `input.delivery_mode` to tools that support its explicit
background/foreground input-delivery ladder. Tutti's native-tool policy is
fail-closed and previously did not recognize that capability, so it rejected
the complete tool whenever the otherwise authorized input action advertised
the new metadata. The same catalog also declares `input.pointer.move` on
`move_cursor`; that capability must accompany the existing
`agent_cursor.move` authorization. This is not an observation-only computer
session and is not a stale macOS TCC grant.

Authorize `input.delivery_mode` and `input.pointer.move` alongside the existing
keyboard, pointer, and `window.activate` capabilities. Delivery mode does not
grant a new class of input by itself; it selects delivery posture for an input
tool already allowed by Tutti. Keep unknown capabilities denied.

### Validation

- With CuaDriver 0.20, `tutti computer tool list --json` marks the input tools
  allowed while a tool carrying an unrelated future capability remains denied.
- Background delivery remains the default; foreground delivery is explicit and
  uses the live native schema.
- Restart the updated tuttid process so it loads the new policy. Existing Agent
  conversations do not need to be recreated because native tools are listed and
  authorized live on every call.

## Screen Recording is enabled but Tutti says it has not taken effect

### Symptom

macOS System Settings shows CuaDriver enabled for both Accessibility and Screen
Recording, but Tutti reports Screen Recording as authorized but not effective.
`cua-driver permissions status --json` may report both TCC grants as `true`
while returning `screen_recording_capturable: null` and
`direct_capture_status: "not_checked"`.

### Root cause and fix

CuaDriver 0.20 keeps its read-only permission status content-free and does not
run the prompt-capable direct-capture probe. A nullable
`screen_recording_capturable` therefore means the probe was not run, not that
capture failed. Tutti treats the two states separately: an explicit `false`
remains not ready, while `null` is accepted when Accessibility and Screen
Recording are both granted. Actual computer actions still cross CuaDriver's
own permission enforcement boundary.

Do not repeatedly toggle the macOS permission or reinstall CuaDriver solely
because the nullable probe field is present. Use the exact daemon-attributed
status payload to distinguish an unprobed result from an explicit capture
failure.

### Validation

- `cua-driver permissions status --json` attributes the response to
  `com.trycua.driver` and reports Accessibility and Screen Recording as `true`.
- A nullable capture probe no longer keeps Tutti in the authorization wizard.
- An explicit `screen_recording_capturable: false` still shows the recovery
  path and blocks computer-use readiness.
- The daemon and desktop apply the same nullable-versus-false interpretation.

## A computer click reports success but the UI does not change

### Symptom

A stable or native computer click reports that it was posted, but a fresh
screenshot shows no UI change. This commonly affects Electron-based apps. The
agent-cursor overlay may also appear offset from the intended point after a
display-configuration change.

### Quick checks

1. Capture a fresh target-window screenshot with the same explicit `pid` and
   `window-id` used for the action.
2. Treat a posted-click response as dispatch confirmation only. Do not use the
   agent-cursor overlay as evidence that the event landed at the displayed
   point.
3. Inspect the screenshot structured content for the target's
   `element_token`. If no suitable element exists, confirm that pixel
   coordinates came from the latest screenshot of the same window.
4. Use `computer tool describe --name click --json` before native escalation so
   the live cua-driver schema remains the source of truth.

### Root cause

Pixel clicks use background CGEvent delivery. cua-driver can confirm that the
event was dispatched, but it cannot read back the UI effect. Focus-sensitive or
Electron surfaces may silently discard a background synthetic click. The
agent-cursor overlay is rendered through a separate visual channel and may have
a stale display offset, so its apparent position does not validate event
delivery.

### Fix

1. Prefer the native `click` element-token path from the latest screenshot when
   an actionable element is available.
2. Verify the result with another fresh screenshot.
3. If a background pixel click had no effect, do not repeat the same click.
   Follow the live native schema and retry once with
   `delivery_mode: "foreground"`, which briefly fronts the target window.
4. If foreground delivery still has no visible effect, re-snapshot and
   re-resolve the target instead of reusing stale coordinates or tokens.

### Validation

- The post-action screenshot shows the expected state change.
- The action used the same `pid` and `window-id` as its source screenshot.
- Element-token retries use a token from the latest snapshot; stale-token
  errors trigger a new snapshot.
- Pixel escalation follows background, verify, foreground, verify rather than
  repeated unverified clicks.

### References

- [Tutti CLI Contract: Computer command surfaces](../tutti-cli-contract.md#computer-command-surfaces)
- [Injected Computer Use skill](../../../packages/agent/runtimeprep/skill_templates/computer-use.md)

## A Windows native tool call rejects valid-looking JSON

### Symptom

`computer tool call` reports that `arguments-json` is not a JSON object, or a
nested `powershell.exe -Command` invocation changes quotes and backslashes.

### Root cause and fix

JSON embedded in a command string crosses both the outer launcher and Windows
shell parsing boundaries. Serialize the object with the shell's JSON library
and pipe it through `--arguments-json -`; do not launch a second PowerShell
process around the Tutti CLI command. `--arguments-json` remains supported for
simple existing scripts, but the two input sources cannot be combined.
When using Windows PowerShell 5.1, temporarily set `$OutputEncoding` to
`[Text.UTF8Encoding]::new($false)` around the pipeline and restore it in a
`finally` block; its default ASCII encoding cannot preserve non-ASCII JSON.

If the driver returns `isError=true` together with Windows success status
`0x00000000`, treat it as an inconsistent driver result rather than successful
delivery. If it rejects automation of its own authorization process, choose a
different application target; never automate the authorization UI.

### Validation

- Stdin JSON round-trips nested values, backslashes, spaces, and non-ASCII text.
- Every state-changing action is followed by a fresh screenshot.
- An inconsistent success-code error and a protected authorization target have
  explicit diagnostic messages.

## A Windows CUA doctor check is slow or reports UIA fallback

### Symptom

Windows computer-use status takes several seconds, or the driver doctor
reports that optional UI Automation support is unhealthy and is falling back to
Win32-only window tools. A status response may still be authorized because
the installed driver can perform the core Win32 actions.

### Root cause and fix

The Windows doctor probes both the optional UIA adapter and the native Win32
path. A broken accessibility provider can make the optional probe slow or
degraded even when native input remains usable. The desktop and daemon bound
the doctor process at 10 seconds and classify the explicit UIA-to-Win32
fallback as a degraded-but-usable result. CuaDriver 0.18 may emit that fallback
as an ANSI-colored stderr warning before the JSON document rather than inside a
JSON diagnostic field. Both adapters therefore inspect the complete output,
but only after validating that it contains a parseable doctor JSON result. The
desktop preserves the diagnostic with reason `driver-doctor-failed`, while the
daemon keeps host-managed computer tools available. A real timeout, malformed
response, or missing driver remains an unknown/not-ready result; do not silently
treat those as healthy.

### Validation

- Run the exact installed `cua-driver doctor --json` executable and record
  whether the response is healthy, degraded, timed out, or unparseable.
- Confirm degraded output keeps Win32 computer actions available while the
  diagnostic warns that UIA-specific window operations may not work.
- Cover both a fallback stored inside the JSON document and an ANSI/stderr
  fallback prefix followed by an otherwise valid JSON document.
- Confirm a real doctor timeout returns within 10 seconds and does not leave a
  child process running.
