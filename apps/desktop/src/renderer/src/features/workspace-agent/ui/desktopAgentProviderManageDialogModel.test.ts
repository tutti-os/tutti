import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { projectDesktopAgentProviderManageRow } from "./desktopAgentProviderManageDialogModel.ts";

test("projects ready provider as connected without an action", () => {
  assert.deepEqual(
    projectDesktopAgentProviderManageRow({
      isLoading: false,
      pendingActions: [],
      provider: "codex",
      status: createStatus({
        actions: [],
        adapterInstalled: true,
        availability: "ready",
        provider: "codex"
      })
    }),
    {
      actionDisabled: true,
      configDetected: true,
      pending: false,
      primaryActionId: null,
      provider: "codex",
      status: "connected"
    }
  );
});

test("projects not installed provider to a connect action", () => {
  assert.deepEqual(
    projectDesktopAgentProviderManageRow({
      isLoading: false,
      pendingActions: [],
      provider: "hermes",
      status: createStatus({
        actions: [{ id: "install", kind: "daemon_action" }],
        adapterInstalled: true,
        availability: "not_installed",
        provider: "hermes"
      })
    }),
    {
      actionDisabled: false,
      configDetected: true,
      pending: false,
      primaryActionId: "install",
      provider: "hermes",
      status: "available"
    }
  );
});

test("projects auth required provider to a login action", () => {
  assert.deepEqual(
    projectDesktopAgentProviderManageRow({
      isLoading: false,
      pendingActions: [],
      provider: "claude-code",
      status: createStatus({
        actions: [{ id: "login", kind: "terminal_command" }],
        adapterInstalled: true,
        availability: "auth_required",
        provider: "claude-code"
      })
    }),
    {
      actionDisabled: false,
      configDetected: true,
      pending: false,
      primaryActionId: "login",
      provider: "claude-code",
      status: "auth_required"
    }
  );
});

test("projects unsupported provider as disabled", () => {
  const row = projectDesktopAgentProviderManageRow({
    isLoading: false,
    pendingActions: [],
    provider: "openclaw",
    status: createStatus({
      actions: [{ id: "refresh", kind: "refresh" }],
      adapterInstalled: true,
      availability: "unsupported",
      provider: "openclaw"
    })
  });

  assert.equal(row.status, "unsupported");
  assert.equal(row.primaryActionId, null);
  assert.equal(row.actionDisabled, true);
});

test("projects pending action as disabled", () => {
  const row = projectDesktopAgentProviderManageRow({
    isLoading: false,
    pendingActions: [{ actionId: "install", provider: "codex" }],
    provider: "codex",
    status: createStatus({
      actions: [{ id: "install", kind: "daemon_action" }],
      adapterInstalled: false,
      availability: "not_installed",
      provider: "codex"
    })
  });

  assert.equal(row.primaryActionId, "install");
  assert.equal(row.pending, true);
  assert.equal(row.actionDisabled, true);
});

test("projects missing provider as checking while loading", () => {
  assert.deepEqual(
    projectDesktopAgentProviderManageRow({
      isLoading: true,
      pendingActions: [],
      provider: "hermes",
      status: null
    }),
    {
      actionDisabled: true,
      configDetected: false,
      pending: false,
      primaryActionId: null,
      provider: "hermes",
      status: "checking"
    }
  );
});

function createStatus(input: {
  actions: AgentProviderStatus["actions"];
  adapterInstalled: boolean;
  availability: AgentProviderStatus["availability"]["status"];
  provider: WorkspaceAgentProvider;
}): AgentProviderStatus {
  return {
    actions: input.actions,
    adapter: {
      command: [],
      installed: input.adapterInstalled
    },
    auth: {
      status: input.availability === "auth_required" ? "required" : "unknown"
    },
    availability: {
      status: input.availability
    },
    cli: {
      installed: input.availability !== "not_installed"
    },
    provider: input.provider
  };
}
