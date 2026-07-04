import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "IssueManagerLatestRunMessageCenterCard.tsx"
  ),
  "utf8"
);

test("issue manager card routes deck submit through submitPlanDecision", () => {
  // A synthesized Codex plan-implementation prompt must take the planMode-off +
  // literal-send path (submitPlanDecision), not a raw interactive submission.
  assert.match(source, /workspaceAgentActivityService\.submitPlanDecision\(/);
  assert.match(source, /promptKind: item\.pendingPrompt\?\.kind/);
});

test("issue manager card does not submit the deck prompt interactively", () => {
  // The deck submit handler must no longer call submitInteractive directly,
  // which would mis-handle a plan-implementation decision.
  assert.doesNotMatch(
    source,
    /workspaceAgentActivityService\.submitInteractive\(/
  );
});

test("issue manager card projects latest runs through message center snapshot", () => {
  // While a run is actively streaming, the workspace agent activity snapshot
  // frequently has not yet reconciled the session (that requires a request
  // round-trip after the run starts). Without synthesizing a session entry
  // from already-cached messages, the card falls back to a bare status
  // digest instead of the real agent reply, which is what made the reply
  // look unrendered specifically while running. Assert the model/session
  // lookups run against the synthesized snapshot, not the raw one, so a
  // cached-but-not-yet-tracked session's messages are picked up.
  assert.match(source, /issueManagerLatestRunMessageCenterSnapshot/);
  assert.match(
    source,
    /buildWorkspaceAgentMessageCenterModel\(messageCenterSnapshot,/
  );
  assert.match(source, /findWorkspaceAgentSession\(messageCenterSnapshot,/);
});

test("issue manager card only synthesizes a session once its messages are cached", () => {
  // Synthesizing a session unconditionally (or before any message content
  // is cached) would render an empty/placeholder detail pane instead of a
  // digest that at least reflects the run's own summary text. The
  // synthesis must be gated on already-cached messages and skipped once the
  // real session is tracked.
  assert.match(source, /hasCachedIssueManagerRunMessages/);
  assert.match(source, /findWorkspaceAgentSession\(snapshot, agentSessionId\)/);
});
