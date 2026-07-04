import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import {
  desktopManagedAgentProviders,
  ensureDesktopManagedAgentProviderStatuses,
  isDesktopManagedAgentProvider,
  projectDesktopManagedAgentsState,
  projectDesktopManagedAgentsStateForAgentGUI
} from "./desktopManagedAgentProviders.ts";

test("ensureDesktopManagedAgentProviderStatuses delegates managed provider loading to the status service", async () => {
  const calls: WorkspaceAgentProvider[][] = [];
  const service = {
    ensureLoaded: async (input) => {
      calls.push([...(input?.providers ?? [])]);
      return null;
    }
  } as Partial<IAgentProviderStatusService> as IAgentProviderStatusService;

  await ensureDesktopManagedAgentProviderStatuses(service);

  assert.deepEqual(calls, [[...desktopManagedAgentProviders]]);
});

test("projectDesktopManagedAgentsState derives AgentGUI managed state from provider status", () => {
  const state = projectDesktopManagedAgentsState({
    capturedAt: "2026-06-02T08:00:00.000Z",
    defaultProvider: "codex",
    error: null,
    isLoading: false,
    pendingActions: [],
    statuses: [
      createProviderStatus({
        adapterInstalled: true,
        availability: "ready",
        cliInstalled: true,
        provider: "claude-code"
      }),
      createProviderStatus({
        adapterInstalled: true,
        availability: "auth_required",
        cliInstalled: true,
        provider: "codex",
        reasonCode: "auth_required"
      })
    ]
  });

  assert.deepEqual(state.readyAgentIds, ["claude-code"]);
  assert.deepEqual(state.configSyncedAgentIds, ["claude-code", "codex"]);
  assert.equal(state.metadataSynced, true);
  assert.equal(state.items[0]?.agentId, "claude-code");
  assert.equal(state.items[1]?.agentId, "codex");
  assert.equal(state.items[1]?.decisionReason, "auth_required");
});

test("projectDesktopManagedAgentsStateForAgentGUI keeps provider readiness unknown before first snapshot", () => {
  const state = projectDesktopManagedAgentsStateForAgentGUI({
    capturedAt: null,
    defaultProvider: null,
    error: null,
    isLoading: true,
    pendingActions: [],
    statuses: []
  });

  assert.equal(state, null);
});

test("projectDesktopManagedAgentsStateForAgentGUI projects captured provider status", () => {
  const state = projectDesktopManagedAgentsStateForAgentGUI({
    capturedAt: "2026-06-02T08:00:00.000Z",
    defaultProvider: "codex",
    error: null,
    isLoading: false,
    pendingActions: [],
    statuses: [
      createProviderStatus({
        adapterInstalled: true,
        availability: "ready",
        cliInstalled: true,
        provider: "codex"
      })
    ]
  });

  assert.deepEqual(state?.readyAgentIds, ["codex"]);
});

test("isDesktopManagedAgentProvider accepts only desktop managed providers", () => {
  assert.equal(isDesktopManagedAgentProvider("claude-code"), true);
  assert.equal(isDesktopManagedAgentProvider("not-a-provider"), false);
});

function createProviderStatus(input: {
  adapterInstalled: boolean;
  availability: AgentProviderStatus["availability"]["status"];
  cliInstalled: boolean;
  provider: WorkspaceAgentProvider;
  reasonCode?: string;
}): AgentProviderStatus {
  return {
    actions: [],
    adapter: {
      command: [],
      installed: input.adapterInstalled
    },
    auth: {
      status: input.availability === "auth_required" ? "required" : "unknown"
    },
    availability: {
      reasonCode: input.reasonCode,
      status: input.availability
    },
    cli: {
      installed: input.cliInstalled
    },
    provider: input.provider
  };
}
