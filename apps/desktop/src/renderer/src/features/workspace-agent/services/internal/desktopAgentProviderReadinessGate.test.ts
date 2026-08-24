import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { projectDesktopAgentProviderReadinessGates } from "./desktopAgentProviderReadinessGate.ts";

test("projectDesktopAgentProviderReadinessGates maps provider availability to AgentGUI gates", () => {
  let modelPlanSetupProvider: string | null = null;
  const gates = projectDesktopAgentProviderReadinessGates({
    onModelPlanSetup: (provider) => {
      modelPlanSetupProvider = provider;
    },
    snapshot: {
      capturedAt: "2026-07-03T00:00:00.000Z",
      defaultProvider: "codex",
      error: null,
      isLoading: false,
      pendingActions: [{ provider: "codex", actionId: "install" }],
      statuses: [
        providerStatus("codex", "not_installed"),
        providerStatus("claude-code", "auth_required"),
        providerStatus("tutti-agent", "auth_required"),
        providerStatus("opencode", "ready"),
        providerStatus("openclaw", "unsupported")
      ]
    }
  });

  assert.equal(gates.codex?.status, "not_installed");
  assert.equal(gates.codex?.pendingAction, "install");
  assert.equal(typeof gates.codex?.onModelPlanSetup, "function");
  assert.equal(gates["claude-code"]?.status, "auth_required");
  assert.equal(typeof gates["claude-code"]?.onModelPlanSetup, "function");
  assert.equal(gates["tutti-agent"]?.status, "auth_required");
  assert.equal(gates.opencode, null);
  assert.equal(gates.openclaw?.status, "unavailable");
  assert.equal(gates.openclaw?.onModelPlanSetup, undefined);

  gates.codex?.onModelPlanSetup?.();
  assert.equal(modelPlanSetupProvider, "codex");
});

test("projectDesktopAgentProviderReadinessGates gates missing provider statuses while loading", () => {
  const gates = projectDesktopAgentProviderReadinessGates({
    snapshot: {
      capturedAt: null,
      defaultProvider: null,
      error: null,
      isLoading: true,
      pendingActions: [],
      statuses: []
    }
  });

  assert.equal(gates.codex?.status, "checking");
  assert.equal(gates["claude-code"]?.status, "checking");
});

test("projectDesktopAgentProviderReadinessGates keeps missing providers checking in partial snapshots", () => {
  const gates = projectDesktopAgentProviderReadinessGates({
    snapshot: {
      capturedAt: "2026-07-15T00:00:00.000Z",
      defaultProvider: "codex",
      error: null,
      isLoading: false,
      pendingActions: [],
      statuses: [providerStatus("codex", "ready")]
    }
  });

  assert.equal(gates.codex, null);
  assert.equal(gates["claude-code"]?.status, "checking");
});

test("projectDesktopAgentProviderReadinessGates lets users retry missing statuses after a failed first check", () => {
  const gates = projectDesktopAgentProviderReadinessGates({
    snapshot: {
      capturedAt: null,
      defaultProvider: null,
      error: "provider status request timed out",
      isLoading: false,
      pendingActions: [],
      statuses: []
    }
  });

  assert.equal(gates.codex?.status, "unavailable");
  assert.equal(gates.codex?.pendingAction, null);
});

test("projectDesktopAgentProviderReadinessGates routes a Codex runtime choice to selection", () => {
  const gates = projectDesktopAgentProviderReadinessGates({
    snapshot: {
      capturedAt: "2026-07-30T00:00:00.000Z",
      defaultProvider: "codex",
      error: null,
      isLoading: false,
      pendingActions: [],
      statuses: [
        providerStatus("codex", "unknown", "codex_runtime_selection_required")
      ]
    }
  });

  assert.equal(gates.codex?.status, "runtime_selection");
});

test("projectDesktopAgentProviderReadinessGates keeps a generic unknown unavailable", () => {
  const gates = projectDesktopAgentProviderReadinessGates({
    snapshot: {
      capturedAt: "2026-07-30T00:00:00.000Z",
      defaultProvider: "codex",
      error: null,
      isLoading: false,
      pendingActions: [],
      statuses: [providerStatus("codex", "unknown", "cli_probe_failed")]
    }
  });

  assert.equal(gates.codex?.status, "unavailable");
});

function providerStatus(
  provider: WorkspaceAgentProvider,
  availability: AgentProviderStatus["availability"]["status"],
  reasonCode?: string | null
): AgentProviderStatus {
  return {
    actions: [],
    adapter: {
      command: [],
      installed: availability !== "not_installed"
    },
    auth: {
      status: availability === "auth_required" ? "required" : "authenticated"
    },
    availability: {
      reasonCode:
        reasonCode !== undefined
          ? reasonCode
          : availability === "ready"
            ? null
            : availability,
      status: availability
    },
    cli: {
      installed: availability !== "not_installed"
    },
    provider,
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
