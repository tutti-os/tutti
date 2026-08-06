import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceAgentDecisionIdentity } from "./workspaceAgentDecisionNotificationIdentity.ts";

test("decision notification uses the exact Agent Directory name and icon", () => {
  const identity = resolveWorkspaceAgentDecisionIdentity({
    agentAvatarUrl: "agent-icon://kimi-code",
    agentName: "Kimi Code",
    fallbackAgentIconUrl: "agent-icon://generic",
    fallbackAgentName: "Agent"
  });

  assert.deepEqual(identity, {
    agentIconUrl: "agent-icon://kimi-code",
    agentName: "Kimi Code"
  });
});

test("decision notification does not expose provider metadata as fallback identity", () => {
  const identity = resolveWorkspaceAgentDecisionIdentity({
    agentAvatarUrl: null,
    agentName: null,
    fallbackAgentIconUrl: "agent-icon://generic",
    fallbackAgentName: "Agent"
  });

  assert.deepEqual(identity, {
    agentIconUrl: "agent-icon://generic",
    agentName: "Agent"
  });
});
