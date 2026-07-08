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
  hasRequiredDesktopManagedAgentProviderStatuses,
  isDesktopManagedAgentProvider,
  projectDesktopManagedAgentsStateForAgentGUI
} from "./desktopManagedAgentProviders.ts";

test("ensureDesktopManagedAgentProviderStatuses stops waiting after the first ready provider", async () => {
  const calls: WorkspaceAgentProvider[][] = [];
  let snapshot = createProviderStatusSnapshot([]);
  const service = {
    ensureLoaded: async (input) => {
      calls.push([...(input?.providers ?? [])]);
      const provider = input?.providers?.[0];
      if (provider === "codex") {
        snapshot = createProviderStatusSnapshot([
          ...snapshot.statuses,
          createProviderStatus({
            adapterInstalled: true,
            availability: "ready",
            cliInstalled: true,
            provider: "codex"
          })
        ]);
      }
      return null;
    },
    getSnapshot: () => snapshot
  } as Partial<IAgentProviderStatusService> as IAgentProviderStatusService;

  await ensureDesktopManagedAgentProviderStatuses(service);
  await Promise.resolve();

  assert.deepEqual(calls, [["codex"], [...desktopManagedAgentProviders]]);
});

test("ensureDesktopManagedAgentProviderStatuses keeps probing priority providers until one is ready", async () => {
  const calls: WorkspaceAgentProvider[][] = [];
  let snapshot = createProviderStatusSnapshot([]);
  const service = {
    ensureLoaded: async (input) => {
      calls.push([...(input?.providers ?? [])]);
      const provider = input?.providers?.[0];
      if (provider === "codex") {
        snapshot = createProviderStatusSnapshot([
          createProviderStatus({
            adapterInstalled: true,
            availability: "auth_required",
            cliInstalled: true,
            provider: "codex"
          })
        ]);
      }
      if (provider === "claude-code") {
        snapshot = createProviderStatusSnapshot([
          ...snapshot.statuses,
          createProviderStatus({
            adapterInstalled: true,
            availability: "ready",
            cliInstalled: true,
            provider: "claude-code"
          })
        ]);
      }
      return null;
    },
    getSnapshot: () => snapshot
  } as Partial<IAgentProviderStatusService> as IAgentProviderStatusService;

  await ensureDesktopManagedAgentProviderStatuses(service);
  await Promise.resolve();

  assert.deepEqual(calls, [
    ["codex"],
    ["claude-code"],
    [...desktopManagedAgentProviders]
  ]);
});

test("ensureDesktopManagedAgentProviderStatuses returns immediately when a ready provider is already known", async () => {
  const calls: WorkspaceAgentProvider[][] = [];
  const snapshot = createProviderStatusSnapshot([
    createProviderStatus({
      adapterInstalled: true,
      availability: "ready",
      cliInstalled: true,
      provider: "claude-code"
    })
  ]);
  const service = {
    ensureLoaded: async (input) => {
      calls.push([...(input?.providers ?? [])]);
      return null;
    },
    getSnapshot: () => snapshot
  } as Partial<IAgentProviderStatusService> as IAgentProviderStatusService;

  const response = await ensureDesktopManagedAgentProviderStatuses(service);
  await Promise.resolve();

  assert.equal(response?.providers[0]?.provider, "claude-code");
  assert.deepEqual(calls, [[...desktopManagedAgentProviders]]);
});

test("projectDesktopManagedAgentsStateForAgentGUI derives AgentGUI managed state from provider status", () => {
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
        provider: "claude-code"
      }),
      createProviderStatus({
        adapterInstalled: true,
        availability: "auth_required",
        cliInstalled: true,
        provider: "codex",
        reasonCode: "auth_required"
      }),
      createProviderStatus({
        adapterInstalled: true,
        availability: "ready",
        cliInstalled: true,
        provider: "opencode"
      })
    ]
  });

  assert.deepEqual(state?.readyAgentIds, ["claude-code", "opencode"]);
  assert.deepEqual(state?.configSyncedAgentIds, [
    "claude-code",
    "codex",
    "opencode"
  ]);
  assert.equal(state?.metadataSynced, true);
  assert.equal(state?.items[0]?.agentId, "claude-code");
  assert.equal(state?.items[1]?.agentId, "codex");
  assert.equal(state?.items[1]?.decisionReason, "auth_required");
  assert.equal(
    state?.items.find((item) => item.agentId === "opencode")?.decisionReason,
    "ready"
  );
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

test("hasRequiredDesktopManagedAgentProviderStatuses waits for required provider", () => {
  const snapshot = createProviderStatusSnapshot([
    createProviderStatus({
      adapterInstalled: true,
      availability: "ready",
      cliInstalled: true,
      provider: "codex"
    })
  ]);

  assert.equal(
    hasRequiredDesktopManagedAgentProviderStatuses(snapshot, ["cursor"]),
    false
  );
  assert.equal(
    hasRequiredDesktopManagedAgentProviderStatuses(snapshot, ["codex"]),
    true
  );
});

test("hasRequiredDesktopManagedAgentProviderStatuses keeps empty snapshot loading", () => {
  assert.equal(
    hasRequiredDesktopManagedAgentProviderStatuses(
      createProviderStatusSnapshot([]),
      ["cursor"]
    ),
    false
  );
});

test("isDesktopManagedAgentProvider accepts only desktop managed providers", () => {
  assert.equal(isDesktopManagedAgentProvider("claude-code"), true);
  assert.equal(isDesktopManagedAgentProvider("opencode"), true);
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

function createProviderStatusSnapshot(
  statuses: readonly AgentProviderStatus[]
) {
  return {
    capturedAt: statuses.length > 0 ? "2026-06-02T08:00:00.000Z" : null,
    defaultProvider: statuses[0]?.provider ?? null,
    error: null,
    isLoading: false,
    pendingActions: [],
    statuses
  };
}
