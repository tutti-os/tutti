import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTargetPresentation } from "../../workspace-agent/services/agentsService.interface.ts";
import { projectWorkspaceAgentExtensionSettingsRows } from "./workspaceAgentExtensionSettingsModel.ts";

test("extension rows are gated by Early Access integrations", () => {
  assert.deepEqual(
    projectWorkspaceAgentExtensionSettingsRows({
      agentExtensions: [],
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
    agentExtensions: [catalogEntry("data:image/svg+xml;base64,catalog")],
    agentTargets: [extensionTarget("extension:gemini", "auth_required")],
    directoryLoading: false,
    earlyAccessEnabled: true,
    featureFlags: { "agent.extension.gemini": true }
  });

  assert.equal(rows.length, 5);
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

test("extension rows use the daemon catalog icon before an Agent Target exists", () => {
  const rows = projectWorkspaceAgentExtensionSettingsRows({
    agentExtensions: [catalogEntry("data:image/svg+xml;base64,catalog")],
    agentTargets: [],
    directoryLoading: false,
    earlyAccessEnabled: true,
    featureFlags: {}
  });

  assert.equal(rows[0]?.iconUrl, "data:image/svg+xml;base64,catalog");
  assert.equal(rows[0]?.status, "unknown");
});

function catalogEntry(iconUrl: string) {
  return {
    iconUrl,
    key: "gemini",
    name: "Gemini CLI",
    targetId: "extension:gemini"
  } as const;
}

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
