import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceChromeSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "WorkspaceChrome.tsx"),
  "utf8"
);
const messageCenterActionSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "WorkspaceAgentMessageCenterAction.tsx"
  ),
  "utf8"
);
const messageCenterModelSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "useWorkspaceAgentMessageCenterModel.ts"
  ),
  "utf8"
);
const waitingNotificationOwnerSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "WorkspaceAgentWaitingNotificationOwner.tsx"
  ),
  "utf8"
);

test("workspace chrome header releases the drag region while the message center is open", () => {
  assert.match(
    workspaceChromeSource,
    /messageCenterOpen\s*\?\s*"\[-webkit-app-region:no-drag\]"\s*:\s*"\[-webkit-app-region:drag\]"/
  );
  assert.doesNotMatch(
    workspaceChromeSource,
    /min-h-\[52px\][^"]*\[-webkit-app-region:drag\]/
  );
  assert.match(workspaceChromeSource, /open=\{messageCenterOpen\}/);
  assert.match(workspaceChromeSource, /setOpen=\{setMessageCenterOpen\}/);
});

test("workspace message center submit forwards to submitPlanDecision instead of branching on plan action", () => {
  // Must call submitPlanDecision with promptKind threaded from the panel
  assert.match(
    messageCenterActionSource,
    /workspaceAgentActivityService\.submitPlanDecision\(/
  );
  assert.match(
    messageCenterActionSource,
    /promptKind: input\.promptKind \?\? ""/
  );

  // Must NOT contain the old plan-implementation branch inside onSubmitPrompt
  assert.doesNotMatch(
    messageCenterActionSource,
    /PLAN_IMPLEMENTATION_ACTION_IMPLEMENT/
  );
  assert.doesNotMatch(messageCenterActionSource, /PLAN_IMPLEMENTATION_PROMPT/);
});

test("workspace message center does not call updateSessionSettings or sendInput from the deck submit handler", () => {
  // Ensure the old branching logic in onSubmitPrompt is removed
  // The separate waiting-notification owner uses submitInteractive; that is
  // expected to stay outside this message-center handler.
  // But updateSessionSettings + sendInput pair for plan mode must be gone from deck handler
  const deckSubmitMatch = messageCenterActionSource.match(
    /const handleMessageCenterSubmitPrompt = useCallback\(\s*async \(input: \{[\s\S]*?\}\) => \{([\s\S]*?)\},\s*\[workspace\.id, workspaceAgentActivityService\]\s*\)/
  );
  assert.ok(
    deckSubmitMatch,
    "message center submit handler should be present in WorkspaceAgentMessageCenterAction"
  );
  const handler = deckSubmitMatch[1] ?? "";
  assert.doesNotMatch(handler, /updateSessionSettings/);
  assert.doesNotMatch(handler, /sendInput/);
  assert.doesNotMatch(handler, /submitInteractive/);
  assert.match(
    messageCenterActionSource,
    /onSubmitPrompt=\{handleMessageCenterSubmitPrompt\}/
  );
});

test("workspace message center model coalesces activity snapshots before notifying React", () => {
  assert.match(
    messageCenterModelSource,
    /function createCoalescedActivityListener\(listener: \(\) => void\)/
  );
  assert.match(
    messageCenterModelSource,
    /frameId = requestAnimationFrame\(flush\);\s*timeoutId = setTimeout\(flush, activityListenerMaxDelayMs\);/
  );
  assert.match(messageCenterModelSource, /coalescedListener\.schedule\(\);/);
  assert.doesNotMatch(
    messageCenterModelSource,
    /workspaceAgentActivityService\.subscribe\(\s*input\.workspaceId,\s*\(nextSnapshot\) => \{[\s\S]*?listener\(\);[\s\S]*?\}\s*\)/
  );
});

test("waiting notification owner gates the agent decision toast on window focus, message center visibility, and the session's own AgentGUI window", () => {
  // The decision toast must consult message-center visibility, window focus,
  // and whether the session's own AgentGUI window is already open (via
  // shouldShowWorkspaceAgentDecisionToast) before popping up, so it does not
  // interrupt the user while the workspace window is unfocused or the
  // conversation is already visible.
  assert.match(
    waitingNotificationOwnerSource,
    /shouldShowWorkspaceAgentDecisionToast\(\{\s*agentGuiSessionOpen: isWorkspaceAgentGuiSessionOpen\(\s*workspaceId,\s*item\.agentSessionId\s*\),\s*messageCenterOpen,\s*windowForeground: windowForegroundVisibility\.isForeground\(\)\s*\}\)/
  );
  // The OS notification path (background-only presentation) must remain
  // unconditional here — it is the mechanism that already correctly gates on
  // focus for the OS face, and the message-center model/list must keep
  // reflecting pending items regardless of toast visibility.
  assert.match(
    waitingNotificationOwnerSource,
    /notifications\.notify\(osMessage\);\s*if \(!showDecisionToasts\) \{\s*continue;\s*\}\s*if \(\s*!shouldShowWorkspaceAgentDecisionToast/
  );
  assert.match(
    waitingNotificationOwnerSource,
    /createDocumentNotificationVisibilityState\(\{\s*hasFocus: \(\) => document\.hasFocus\(\),\s*visibilityState: \(\) => document\.visibilityState\s*\}\)/
  );
});
