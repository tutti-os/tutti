import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Regression test for a bug where AgentGUINode's onShowMessage callback (used
// e.g. to tell the user a Codex permission-mode change will only apply
// starting with their next message, see
// useAgentGUINodeController's "messages.agentPermissionModeAppliesNextTurn"
// path) was wired to a no-op on desktop, so the message was computed and
// handed to the callback but never actually shown to the user anywhere.
const workbenchBodySource = readFileSync(
  new URL("./DesktopAgentGUIWorkbenchBody.tsx", import.meta.url),
  "utf8"
);

test("desktop AgentGUI onShowMessage is wired to a real toast, not the shared no-op", () => {
  assert.doesNotMatch(
    workbenchBodySource,
    /onShowMessage=\{DESKTOP_AGENT_GUI_NOOP\}/
  );
  assert.match(
    workbenchBodySource,
    /onShowMessage=\{handleDesktopAgentGUIShowMessage\}/
  );
});

test("handleDesktopAgentGUIShowMessage routes error tone to Toast.Error and other tones to Toast.tips", () => {
  assert.match(
    workbenchBodySource,
    /function handleDesktopAgentGUIShowMessage\(\s*message: string,\s*tone\?: "info" \| "warning" \| "error"\s*\): void \{\s*if \(tone === "error"\) \{\s*Toast\.Error\(message\);\s*return;\s*\}\s*Toast\.tips\(message\);\s*\}/
  );
});
