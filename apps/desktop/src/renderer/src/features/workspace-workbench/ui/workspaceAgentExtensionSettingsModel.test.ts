import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTargetPresentation } from "../../workspace-agent/services/agentsService.interface.ts";
import { projectWorkspaceAgentExtensionSettingsRows } from "./workspaceAgentExtensionSettingsModel.ts";

test("stable extension rows remain visible without Early Access", () => {
  const rows = projectWorkspaceAgentExtensionSettingsRows({
    agentTargets: [],
    directoryLoading: false,
    earlyAccessEnabled: false,
    featureFlags: { "agent.extension.gemini": true }
  });

  assert.deepEqual(
    rows.map((row) => ({
      activationFlag: row.activationFlag,
      agentTargetId: row.agentTargetId,
      earlyAccess: row.earlyAccess,
      toggleDisabled: row.toggleDisabled
    })),
    [
      {
        activationFlag: null,
        agentTargetId: "extension:hermes",
        earlyAccess: false,
        toggleDisabled: true
      },
      {
        activationFlag: null,
        agentTargetId: "extension:kimi-code",
        earlyAccess: false,
        toggleDisabled: true
      }
    ]
  );
});

test("stable targets and early-access activation project independently", () => {
  const rows = projectWorkspaceAgentExtensionSettingsRows({
    agentTargets: [
      extensionTarget("extension:hermes", "ready"),
      extensionTarget("extension:gemini", "auth_required")
    ],
    directoryLoading: false,
    earlyAccessEnabled: true,
    featureFlags: { "agent.extension.gemini": true }
  });

  assert.equal(rows.length, 8);
  assert.deepEqual(rows[0], {
    activationFlag: null,
    agentTargetId: "extension:hermes",
    earlyAccess: false,
    enabled: true,
    iconUrl: "data:image/png;base64,hermes",
    key: "hermes",
    labelKey: "workspace.settings.agent.agents.extensionHermes",
    status: "connected",
    toggleDisabled: false
  });
  assert.deepEqual(rows[2], {
    activationFlag: "agent.extension.gemini",
    agentTargetId: "extension:gemini",
    earlyAccess: true,
    enabled: true,
    iconUrl: "data:image/png;base64,gemini",
    key: "gemini",
    labelKey: "workspace.settings.agent.agents.extensionGemini",
    status: "auth_required",
    toggleDisabled: false
  });
  assert.equal(rows[3]?.enabled, false);
  assert.equal(rows[3]?.status, "unknown");
});

function extensionTarget(
  agentTargetId: string,
  status: AgentTargetPresentation["availability"]["status"]
): AgentTargetPresentation {
  const key = agentTargetId.replace("extension:", "");
  return {
    agentTargetId,
    availability: { status },
    createdAtUnixMs: 1,
    enabled: true,
    heroImageUrl: null,
    iconKey: agentTargetId,
    iconUrl: `data:image/png;base64,${key}`,
    launchRefType: "agent_extension",
    maskIconUrl: null,
    name: key,
    provider: `acp:${key}`,
    sortOrder: 700,
    source: "system",
    updatedAtUnixMs: 1
  };
}
