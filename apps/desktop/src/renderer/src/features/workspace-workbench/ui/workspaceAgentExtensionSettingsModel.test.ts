import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTargetPresentation } from "../../workspace-agent/services/agentsService.interface.ts";
import { projectWorkspaceAgentExtensionSettingsRows } from "./workspaceAgentExtensionSettingsModel.ts";

test("extension rows are gated by Early Access integrations", () => {
  assert.deepEqual(
    projectWorkspaceAgentExtensionSettingsRows({
      agentTargets: [],
      directoryLoading: false,
      earlyAccessEnabled: false,
      featureFlags: { "agent.extension.gemini": true }
    }),
    []
  );
});

test("extension activation and Agent Target availability project independently", () => {
  const rows = projectWorkspaceAgentExtensionSettingsRows({
    agentTargets: [extensionTarget("extension:gemini", "auth_required")],
    directoryLoading: false,
    earlyAccessEnabled: true,
    featureFlags: { "agent.extension.gemini": true }
  });

  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], {
    activationFlag: "agent.extension.gemini",
    agentTargetId: "extension:gemini",
    enabled: true,
    iconUrl: "data:image/png;base64,gemini",
    key: "gemini",
    labelKey: "workspace.settings.agent.agents.extensionGemini",
    status: "auth_required"
  });
  assert.equal(rows[1]?.enabled, false);
  assert.equal(rows[1]?.status, "unknown");
});

function extensionTarget(
  agentTargetId: string,
  status: AgentTargetPresentation["availability"]["status"]
): AgentTargetPresentation {
  return {
    agentTargetId,
    availability: { status },
    createdAtUnixMs: 1,
    enabled: true,
    heroImageUrl: null,
    iconKey: "extension:gemini",
    iconUrl: "data:image/png;base64,gemini",
    launchRefType: "agent_extension",
    maskIconUrl: null,
    name: "Gemini CLI",
    provider: "acp:gemini",
    sortOrder: 700,
    source: "system",
    updatedAtUnixMs: 1
  };
}
