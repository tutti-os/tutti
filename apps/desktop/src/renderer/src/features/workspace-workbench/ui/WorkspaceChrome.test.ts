import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "WorkspaceChrome.tsx"),
  "utf8"
);

test("workspace chrome header releases the drag region while the message center is open", () => {
  assert.match(
    source,
    /messageCenterOpen\s*\?\s*"\[-webkit-app-region:no-drag\]"\s*:\s*"\[-webkit-app-region:drag\]"/
  );
  assert.doesNotMatch(source, /min-h-\[52px\][^"]*\[-webkit-app-region:drag\]/);
  assert.match(source, /open=\{messageCenterOpen\}/);
  assert.match(source, /setOpen=\{setMessageCenterOpen\}/);
});

test("workspace chrome deck submit forwards to submitPlanDecision instead of branching on plan action", () => {
  // Must call submitPlanDecision with promptKind threaded from the panel
  assert.match(source, /workspaceAgentActivityService\.submitPlanDecision\(/);
  assert.match(source, /promptKind: input\.promptKind/);

  // Must NOT contain the old plan-implementation branch inside onSubmitPrompt
  assert.doesNotMatch(source, /PLAN_IMPLEMENTATION_ACTION_IMPLEMENT/);
  assert.doesNotMatch(source, /PLAN_IMPLEMENTATION_PROMPT/);
});

test("workspace chrome does not call updateSessionSettings or sendInput from the deck submit handler", () => {
  // Ensure the old branching logic in onSubmitPrompt is removed
  // (toast notification path at line 484 uses submitInteractive — that is expected to stay)
  // But updateSessionSettings + sendInput pair for plan mode must be gone from deck handler
  const deckSubmitMatch = source.match(
    /const handleMessageCenterSubmitPrompt = useCallback\(\s*async \(input: \{[\s\S]*?\}\) => \{([\s\S]*?)\},\s*\[workspace\.id, workspaceAgentActivityService\]\s*\)/
  );
  assert.ok(
    deckSubmitMatch,
    "message center submit handler should be present in WorkspaceChrome"
  );
  const handler = deckSubmitMatch[1] ?? "";
  assert.doesNotMatch(handler, /updateSessionSettings/);
  assert.doesNotMatch(handler, /sendInput/);
  assert.doesNotMatch(handler, /submitInteractive/);
  assert.match(source, /onSubmitPrompt=\{handleMessageCenterSubmitPrompt\}/);
});

test("workspace chrome coalesces agent activity snapshot notifications before notifying React", () => {
  assert.match(
    source,
    /function createCoalescedWorkspaceAgentActivityListener\(listener: \(\) => void\)/
  );
  assert.match(
    source,
    /frameId = requestAnimationFrame\(flush\);\s*timeoutId = setTimeout\(\s*flush,\s*WORKSPACE_AGENT_ACTIVITY_LISTENER_MAX_DELAY_MS\s*\);/
  );
  assert.match(source, /coalescedListener\.schedule\(\);/);
  assert.doesNotMatch(
    source,
    /workspaceAgentActivityService\.subscribe\(\s*workspace\.id,\s*\(nextSnapshot\) => \{[\s\S]*?listener\(\);[\s\S]*?\}\s*\)/
  );
});

test("workspace chrome gates the agent decision toast on window focus, message center visibility, and the session's own AgentGUI window", () => {
  // The decision toast must consult message-center visibility, window focus,
  // and whether the session's own AgentGUI window is already open (via
  // shouldShowWorkspaceAgentDecisionToast) before popping up, so it does not
  // interrupt the user while the workspace window is unfocused or the
  // conversation is already visible.
  assert.match(
    source,
    /shouldShowWorkspaceAgentDecisionToast\(\{\s*agentGuiSessionOpen: isWorkspaceAgentGuiSessionOpen\(\s*workspace\.id,\s*item\.agentSessionId\s*\),\s*messageCenterOpen: open,\s*windowForeground: windowForegroundVisibility\.isForeground\(\)\s*\}\)/
  );
  // The OS notification path (background-only presentation) must remain
  // unconditional here — it is the mechanism that already correctly gates on
  // focus for the OS face, and the message-center model/list must keep
  // reflecting pending items regardless of toast visibility.
  assert.match(
    source,
    /notifications\.notify\(osMessage\);\s*if \(\s*!shouldShowWorkspaceAgentDecisionToast/
  );
  assert.match(
    source,
    /createDocumentNotificationVisibilityState\(\{\s*hasFocus: \(\) => document\.hasFocus\(\),\s*visibilityState: \(\) => document\.visibilityState\s*\}\)/
  );
});
