import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  canConfigureDesktopAgentProvider,
  projectDesktopAgentProviderManageRow
} from "./desktopAgentProviderManageDialogModel.ts";

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
      runtimeSelectionRequired: false,
      status: "connected"
    }
  );
});

test("projects ready provider with only local credentials as configured", () => {
  const row = projectDesktopAgentProviderManageRow({
    isLoading: false,
    pendingActions: [],
    provider: "claude-code",
    status: createStatus({
      actions: [],
      adapterInstalled: true,
      authStatus: "configured",
      availability: "ready",
      provider: "claude-code"
    })
  });

  assert.equal(row.status, "configured");
  assert.equal(row.primaryActionId, null);
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
      runtimeSelectionRequired: false,
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
      runtimeSelectionRequired: false,
      status: "auth_required"
    }
  );
});

test("projects temporarily unsupported provider without a connect action", () => {
  const row = projectDesktopAgentProviderManageRow({
    isLoading: false,
    pendingActions: [],
    provider: "openclaw",
    status: createStatus({
      actions: [],
      adapterInstalled: false,
      availability: "unsupported",
      availabilityReasonCode: "provider_temporarily_unsupported",
      provider: "openclaw"
    })
  });

  assert.equal(row.status, "temporarily_unsupported");
  assert.equal(row.primaryActionId, null);
  assert.equal(row.actionDisabled, true);
  assert.equal(canConfigureDesktopAgentProvider(row.status), false);
});

test("keeps other unsupported runtimes distinct from unavailable providers", () => {
  const row = projectDesktopAgentProviderManageRow({
    isLoading: false,
    pendingActions: [],
    provider: "codex",
    status: createStatus({
      actions: [{ id: "update", kind: "daemon_action" }],
      adapterInstalled: true,
      availability: "unsupported",
      availabilityReasonCode: "codex_version_unsupported",
      provider: "codex"
    })
  });

  assert.equal(row.status, "unsupported");
  assert.equal(canConfigureDesktopAgentProvider(row.status), true);
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
      runtimeSelectionRequired: false,
      status: "checking"
    }
  );
});

test("flags codex runtime selection so the host can offer a choose action", () => {
  const row = projectDesktopAgentProviderManageRow({
    isLoading: false,
    pendingActions: [],
    provider: "codex",
    status: createStatus({
      actions: [],
      adapterInstalled: true,
      availability: "unknown",
      availabilityReasonCode: "codex_runtime_selection_required",
      provider: "codex"
    })
  });

  assert.equal(row.runtimeSelectionRequired, true);
  // Stays "unknown" in the status enum; the flag is what drives the CTA.
  assert.equal(row.status, "unknown");
  assert.equal(row.primaryActionId, null);
});

function createStatus(input: {
  actions: AgentProviderStatus["actions"];
  adapterInstalled: boolean;
  authStatus?: AgentProviderStatus["auth"]["status"];
  availability: AgentProviderStatus["availability"]["status"];
  availabilityReasonCode?: string | null;
  provider: WorkspaceAgentProvider;
}): AgentProviderStatus {
  return {
    actions: input.actions,
    adapter: {
      command: [],
      installed: input.adapterInstalled
    },
    auth: {
      status:
        input.authStatus ??
        (input.availability === "auth_required" ? "required" : "unknown")
    },
    availability: {
      status: input.availability,
      reasonCode: input.availabilityReasonCode ?? null
    },
    cli: {
      installed: input.availability !== "not_installed"
    },
    provider: input.provider,
    update: {
      capability: "unsupported",
      currentVersion: null,
      lastCheckedAt: null,
      latestVersion: null,
      reasonCode: null,
      source: null,
      unsupportedReason: "update_strategy_unsupported",
      updateAvailable: null
    }
  };
}
