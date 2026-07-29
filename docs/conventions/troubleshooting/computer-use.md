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
