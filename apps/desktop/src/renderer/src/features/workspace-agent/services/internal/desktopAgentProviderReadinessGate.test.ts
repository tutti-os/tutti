import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { projectDesktopAgentProviderReadinessGates } from "./desktopAgentProviderReadinessGate.ts";

test("projectDesktopAgentProviderReadinessGates maps provider availability to AgentGUI gates", () => {
  const gates = projectDesktopAgentProviderReadinessGates({
    snapshot: {
      capturedAt: "2026-07-03T00:00:00.000Z",
      defaultProvider: "codex",
      error: null,
      isLoading: false,
      pendingActions: [{ provider: "codex", actionId: "install" }],
      statuses: [
        providerStatus("codex", "not_installed"),
        providerStatus("claude-code", "auth_required"),
        providerStatus("gemini", "ready"),
        providerStatus("openclaw", "unsupported")
      ]
    }
  });

  assert.equal(gates.codex?.status, "not_installed");
  assert.equal(gates.codex?.pendingAction, "install");
  assert.equal(gates["claude-code"]?.status, "auth_required");
  assert.equal(gates.gemini, null);
  assert.equal(gates.openclaw?.status, "unavailable");
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

test("projectDesktopAgentProviderReadinessGates lets users retry missing statuses after a failed first check", () => {
  const actions: Array<[string, string]> = [];
  const gates = projectDesktopAgentProviderReadinessGates({
    snapshot: {
      capturedAt: null,
      defaultProvider: null,
      error: "provider status request timed out",
      isLoading: false,
      pendingActions: [],
      statuses: []
    },
    onAction(provider, action) {
      actions.push([provider, action]);
    }
  });

  assert.equal(gates.codex?.status, "unavailable");
  gates.codex?.onAction?.("codex", "refresh");
  assert.deepEqual(actions, [["codex", "refresh"]]);
});

function providerStatus(
  provider: WorkspaceAgentProvider,
  availability: AgentProviderStatus["availability"]["status"]
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
      reasonCode: availability === "ready" ? null : availability,
      status: availability
    },
    cli: {
      installed: availability !== "not_installed"
    },
    provider
  };
}
