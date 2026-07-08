import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import {
  resolveWorkspaceAgentChatProvider,
  resolveWorkspaceAgentProviderLaunchIntent
} from "./workspaceOpenFeatureRequest.ts";

test("workspace agent chat uses the requested provider before the workspace default", () => {
  assert.equal(
    resolveWorkspaceAgentChatProvider({
      defaultProvider: "codex",
      requestedProvider: "claude-code"
    }),
    "claude-code"
  );
});

test("workspace agent chat falls back to the workspace default provider", () => {
  assert.equal(
    resolveWorkspaceAgentChatProvider({
      defaultProvider: "hermes"
    }),
    "hermes"
  );
});

test("workspace agent launch intent opens only ready providers", () => {
  assert.deepEqual(
    resolveWorkspaceAgentProviderLaunchIntent(
      createStatus({ availability: "ready" })
    ),
    { kind: "launch" }
  );
});

test("workspace agent launch intent routes setup states to setup actions", () => {
  assert.deepEqual(
    resolveWorkspaceAgentProviderLaunchIntent(
      createStatus({
        actions: [{ id: "install", kind: "daemon_action" }],
        availability: "not_installed"
      })
    ),
    { actionId: "install", kind: "action" }
  );
  assert.deepEqual(
    resolveWorkspaceAgentProviderLaunchIntent(
      createStatus({
        actions: [{ id: "login", kind: "terminal_command" }],
        availability: "auth_required"
      })
    ),
    { actionId: "login", kind: "action" }
  );
});

test("workspace agent launch intent blocks unavailable providers without opening agent gui", () => {
  assert.deepEqual(resolveWorkspaceAgentProviderLaunchIntent(null), {
    kind: "blocked"
  });
  assert.deepEqual(
    resolveWorkspaceAgentProviderLaunchIntent(
      createStatus({ availability: "not_installed" })
    ),
    { kind: "blocked" }
  );
  assert.deepEqual(
    resolveWorkspaceAgentProviderLaunchIntent(
      createStatus({ availability: "unsupported" })
    ),
    { kind: "blocked" }
  );
});

function createStatus(input: {
  actions?: AgentProviderStatus["actions"];
  availability: AgentProviderStatus["availability"]["status"];
}): Pick<AgentProviderStatus, "actions" | "availability"> {
  return {
    actions: input.actions ?? [],
    availability: {
      status: input.availability
    }
  };
}
