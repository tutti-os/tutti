import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceAgentGuiSameTypeWindowLaunchRequest } from "./workspaceWorkbenchShortcutAgentLaunch.ts";

test("same-type AgentGUI shortcut preserves open provider and Agent Target", () => {
  const node = {
    data: {
      dockEntryId: "agent-gui:unified",
      instanceId: "agent-gui:acp:gemini:target:extension%3Agemini",
      runtimeNodeState: {
        agentTargetId: "extension:gemini"
      },
      snapshotNodeState: {
        agentTargetId: "stale:target",
        provider: "acp:gemini"
      },
      typeId: "agent-gui"
    }
  };
  assert.deepEqual(
    createWorkspaceAgentGuiSameTypeWindowLaunchRequest(node, "codex"),
    {
      dockEntryId: "agent-gui:unified",
      payload: {
        agentTargetId: "extension:gemini",
        openInNewWindow: true,
        provider: "acp:gemini"
      },
      reason: "host",
      typeId: "agent-gui"
    }
  );
});
