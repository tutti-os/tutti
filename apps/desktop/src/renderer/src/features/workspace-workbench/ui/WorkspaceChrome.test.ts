import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const chromeSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "WorkspaceChrome.tsx"),
  "utf8"
);
const chromeActionsSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "WorkspaceChromeActions.tsx"
  ),
  "utf8"
);
const messageCenterSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "WorkspaceAgentMessageCenterAction.tsx"
  ),
  "utf8"
);
const decisionNotificationsSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "useWorkspaceAgentDecisionNotifications.tsx"
  ),
  "utf8"
);

test("workspace chrome header releases the drag region while the message center is open", () => {
  assert.match(
    chromeSource,
    /messageCenterOpen\s*\?\s*"\[-webkit-app-region:no-drag\]"\s*:\s*"\[-webkit-app-region:drag\]"/
  );
  assert.doesNotMatch(
    chromeSource,
    /min-h-\[52px\][^"]*\[-webkit-app-region:drag\]/
  );
  assert.match(chromeSource, /open=\{messageCenterOpen\}/);
  assert.match(chromeSource, /setOpen=\{setMessageCenterOpen\}/);
});

test("workspace chrome deck submit dispatches plan decisions through the canonical engine", () => {
  assert.match(
    messageCenterSource,
    /dispatchAgentPlanPromptAction\(\{[\s\S]*engine: sessionEngine/
  );
  assert.match(
    messageCenterSource,
    /input\.promptKind === "plan-implementation"/
  );

  // Must NOT contain the old plan-implementation branch inside onSubmitPrompt
  assert.doesNotMatch(
    messageCenterSource,
    /PLAN_IMPLEMENTATION_ACTION_IMPLEMENT/
  );
  assert.doesNotMatch(messageCenterSource, /PLAN_IMPLEMENTATION_PROMPT/);
});

test("workspace message center forwards canonical session identity into AgentGUI launches", () => {
  assert.match(
    messageCenterSource,
    /createWorkspaceAgentGuiSessionLaunchRequest\(\{[\s\S]*?agentSessionId: input\.agentSessionId,[\s\S]*?agentTargetId: input\.agentTargetId,[\s\S]*?provider: input\.provider/
  );
});

test("workspace chrome does not call updateSessionSettings or sendInput from the deck submit handler", () => {
  // Ensure the old branching logic in onSubmitPrompt is removed
  // (toast notification path at line 484 uses submitInteractive — that is expected to stay)
  // But updateSessionSettings + sendInput pair for plan mode must be gone from deck handler
  const deckSubmitMatch = messageCenterSource.match(
    /const handleMessageCenterSubmitPrompt = useCallback\(\s*async \(input: \{[\s\S]*?\}\) => \{([\s\S]*?)\},\s*\[sessionEngine, workspace\.id\]\s*\)/
  );
  assert.ok(
    deckSubmitMatch,
    "message center submit handler should be present in WorkspaceAgentMessageCenterAction"
  );
  const handler = deckSubmitMatch[1] ?? "";
  assert.doesNotMatch(handler, /updateSessionSettings/);
  assert.doesNotMatch(handler, /sendInput/);
  assert.doesNotMatch(handler, /submitInteractive/);
  assert.match(handler, /interaction\/responseRequested/);
  assert.match(handler, /selectEnginePendingInteractions\(/);
  assert.match(handler, /candidate\.requestId === input\.requestId/);
  assert.match(handler, /requestId: input\.requestId/);
  assert.match(handler, /turnId: interaction\.turnId/);
  assert.match(
    handler,
    /input\.payload \? \{ payload: input\.payload \} : \{\}/
  );
  assert.match(
    messageCenterSource,
    /onSubmitPrompt=\{handleMessageCenterSubmitPrompt\}/
  );
});

test("workspace chrome gates the agent decision toast on window focus, message center visibility, and the session's own AgentGUI window", () => {
  // The decision toast must consult message-center visibility, window focus,
  // and whether the session's own AgentGUI window is already open (via
  // shouldShowWorkspaceAgentDecisionToast) before popping up, so it does not
  // interrupt the user while the workspace window is unfocused or the
  // conversation is already visible.
  assert.match(
    messageCenterSource,
    /const isAgentGuiSessionOpenForWorkspace = useCallback\([\s\S]*?isWorkspaceAgentGuiSessionOpen\(workspace\.id, agentSessionId\)[\s\S]*?useWorkspaceAgentDecisionNotifications\(\{[\s\S]*?isAgentGuiSessionOpen: isAgentGuiSessionOpenForWorkspace,[\s\S]*?sendBackgroundNotification: true/
  );
  assert.match(
    decisionNotificationsSource,
    /shouldShowWorkspaceAgentDecisionToast\(\{[\s\S]*?agentGuiSessionOpen:[\s\S]*?isAgentGuiSessionOpen\?\.\(item\.agentSessionId\) \?\? false,[\s\S]*?messageCenterOpen,[\s\S]*?windowForeground: windowForegroundVisibility\.isForeground\(\)/
  );
  // The OS workspace opts into the background-only face before applying the
  // foreground toast visibility gate. Standalone reuses the same controller
  // with this OS face disabled, so opening both renderers cannot duplicate it.
  assert.match(
    decisionNotificationsSource,
    /if \(sendBackgroundNotification\) \{[\s\S]*?notifications\.notify\(osMessage\);[\s\S]*?shouldShowWorkspaceAgentDecisionToast/
  );
  assert.match(
    decisionNotificationsSource,
    /createDocumentNotificationVisibilityState\(\{\s*hasFocus: \(\) => document\.hasFocus\(\),\s*visibilityState: \(\) => document\.visibilityState\s*\}\)/
  );
});

test("workspace chrome derives message-center decisions and pet mood from the canonical engine", () => {
  assert.match(messageCenterSource, /getSessionEngine\(workspace\.id\)/);
  assert.match(
    messageCenterSource,
    /useEngineSelector\(\s*sessionEngine,\s*selectWorkspaceAgentMessageCenterPresentation/
  );
  assert.match(
    messageCenterSource,
    /buildWorkspaceAgentMessageCenterModelFromEngine\(/
  );
  assert.match(
    messageCenterSource,
    /useEngineSelector\(\s*sessionEngine,\s*resolveWorkspaceAgentStatusPetMood/
  );
  assert.doesNotMatch(
    messageCenterSource,
    /buildWorkspaceAgentMessageCenterModel\(/
  );
  assert.doesNotMatch(
    messageCenterSource,
    /resolveWorkspaceAgentStatusPetMood\(snapshot/
  );
});

test("workspace chrome settings opens General while Agent deep links keep their section", () => {
  assert.match(
    chromeActionsSource,
    /settingsPanelRequest\.section as WorkspaceSettingsSectionID/
  );
  assert.match(
    chromeActionsSource,
    /settingsService\.openPanel\(\s*\{ id: workspace\.id \},\s*\{ section: "general" \}\s*\)/
  );
});
