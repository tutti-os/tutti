# Computer Use Troubleshooting

Use this guide for recurring cua-driver and `tutti computer` failures. Keep
stable CLI and authorization contracts in
[Tutti CLI Contract](../tutti-cli-contract.md); keep symptom-driven diagnosis
and recovery here.

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
fallback as a degraded-but-usable result. The desktop preserves its diagnostic
message with reason `driver-doctor-failed`, while the daemon keeps host-managed
computer tools available. A real timeout, malformed response, or missing driver
remains an unknown/not-ready result; do not silently treat those as healthy.

### Validation

- Run the exact installed `cua-driver doctor --json` executable and record
  whether the response is healthy, degraded, timed out, or unparseable.
- Confirm degraded output keeps Win32 computer actions available while the
  diagnostic warns that UIA-specific window operations may not work.
- Confirm a real doctor timeout returns within 10 seconds and does not leave a
  child process running.
