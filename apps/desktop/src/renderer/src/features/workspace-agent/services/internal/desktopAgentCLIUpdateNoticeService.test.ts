import assert from "node:assert/strict";
import test from "node:test";
import type { AgentGUIAgent } from "@tutti-os/agent-gui";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { proxy } from "valtio";
import type { IDesktopPreferencesService } from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import type { IAgentEnvService } from "../agentEnvService.interface.ts";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../agentProviderStatusService.interface.ts";
import type { IAgentsService } from "../agentsService.interface.ts";
import { DesktopAgentCLIUpdateNoticeService } from "./desktopAgentCLIUpdateNoticeService.ts";

test("discovers and projects updates only while an empty Home surface is eligible", async () => {
  const fixture = createFixture();

  assert.deepEqual(fixture.service.getSnapshot().notices, []);
  fixture.service.setSurfaceEligible("node-1", true);
  await Promise.resolve();

  assert.equal(fixture.providerStatus.ensureLoadedCalls, 1);
  assert.deepEqual(fixture.service.getSnapshot().notices, [availableNotice]);

  fixture.service.setSurfaceEligible("node-1", false);
  assert.deepEqual(fixture.service.getSnapshot().notices, []);
  fixture.dispose();
});

test("keeps updating, failure, retry, and completion states convergent", async () => {
  const fixture = createFixture();
  fixture.service.setSurfaceEligible("node-1", true);
  fixture.providerStatus.actionMode = "failure";

  const firstUpdate = fixture.service.runAction({
    action: "update",
    notice: availableNotice
  });
  assert.equal(fixture.service.getSnapshot().notices[0]?.phase, "updating");
  await firstUpdate;
  assert.equal(fixture.service.getSnapshot().notices[0]?.phase, "failed");

  fixture.providerStatus.actionMode = "success";
  await fixture.service.runAction({
    action: "update",
    notice: { ...availableNotice, phase: "failed" }
  });
  assert.deepEqual(fixture.providerStatus.actionRuns, ["codex", "codex"]);
  assert.equal(fixture.service.getSnapshot().notices[0]?.phase, "completed");
  fixture.dispose();
});

test("reconciles a failed card when another update path completes", async () => {
  const fixture = createFixture();
  fixture.service.setSurfaceEligible("node-1", true);
  fixture.providerStatus.actionMode = "failure";
  await fixture.service.runAction({
    action: "update",
    notice: availableNotice
  });
  assert.equal(fixture.service.getSnapshot().notices[0]?.phase, "failed");

  fixture.providerStatus.setStatuses([
    createStatus("codex", { updateAvailable: false })
  ]);
  assert.equal(fixture.service.getSnapshot().notices[0]?.phase, "completed");
  fixture.dispose();
});

test("dismisses the completed state after its confirmation interval", async () => {
  const fixture = createFixture({ completedNoticeDurationMs: 1 });
  fixture.service.setSurfaceEligible("node-1", true);

  await fixture.service.runAction({
    action: "update",
    notice: availableNotice
  });
  assert.equal(fixture.service.getSnapshot().notices[0]?.phase, "completed");

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fixture.service.getSnapshot().notices, []);
  fixture.dispose();
});

test("later and details resolve through the current exact target projection", async () => {
  const fixture = createFixture();
  fixture.service.setSurfaceEligible("node-1", true);

  await fixture.service.runAction({
    action: "details",
    notice: availableNotice
  });
  assert.deepEqual(fixture.agentEnv.opens, [
    { focus: "upgrade", provider: "codex" }
  ]);

  await fixture.service.runAction({
    action: "details",
    notice: { ...availableNotice, agentTargetId: "workspace-agent-codex" }
  });
  assert.equal(fixture.agentEnv.opens.length, 1);
  assert.deepEqual(fixture.providerStatus.actionRuns, []);

  await fixture.service.runAction({ action: "later", notice: availableNotice });
  assert.deepEqual(fixture.service.getSnapshot().notices, []);
  fixture.dispose();
});

test("does not surface cached updates when automatic checks are disabled", () => {
  const fixture = createFixture({ autoCheckEnabled: false });
  fixture.service.setSurfaceEligible("node-1", true);

  assert.equal(fixture.providerStatus.ensureLoadedCalls, 0);
  assert.deepEqual(fixture.service.getSnapshot().notices, []);
  fixture.dispose();
});

test("keeps an exact target snapshot stable when another provider changes", async () => {
  const fixture = createFixture();
  fixture.service.setSurfaceEligible("node-1", true);
  await Promise.resolve();

  const firstSnapshot = fixture.service.getSnapshotForTarget("local:codex");
  fixture.providerStatus.setStatuses([
    createStatus("codex"),
    createStatus("tutti-agent")
  ]);
  const secondSnapshot = fixture.service.getSnapshotForTarget("local:codex");

  assert.strictEqual(secondSnapshot, firstSnapshot);
  assert.deepEqual(secondSnapshot.notices, [availableNotice]);
  fixture.dispose();
});

test("refreshes cached discovery on later window activation without activation spam", async () => {
  const fixture = createFixture();
  fixture.service.setSurfaceEligible("node-1", true, "local:codex");
  assert.equal(await fixture.service.refreshForWindowActivation(), true);
  assert.equal(fixture.providerStatus.ensureLoadedCalls, 1);

  fixture.advance(29_999);
  assert.equal(await fixture.service.refreshForWindowActivation(), false);
  assert.equal(fixture.providerStatus.ensureLoadedCalls, 1);

  fixture.advance(1);
  assert.equal(await fixture.service.refreshForWindowActivation(), true);
  assert.equal(fixture.providerStatus.ensureLoadedCalls, 2);
  fixture.dispose();
});

test("discovers and updates the exact Agent Extension runtime through the shared card", async () => {
  const fixture = createFixture({ extensionUpdateAvailable: true });
  fixture.service.setSurfaceEligible("node-1", true, "extension:kimi-code");
  await fixture.service.refreshForWindowActivation();

  const notice = fixture.service.getSnapshotForTarget("extension:kimi-code")
    .notices[0];
  assert.deepEqual(notice, {
    agentTargetId: "extension:kimi-code",
    currentVersion: "1.49.0",
    latestVersion: "1.50.0",
    phase: "available",
    detailsTarget: "target-runtime"
  });

  await fixture.service.runAction({ action: "update", notice: notice! });
  assert.deepEqual(fixture.extensionUpdateRuns, [
    {
      agentTargetId: "extension:kimi-code",
      currentVersion: "1.49.0",
      latestVersion: "1.50.0"
    }
  ]);
  assert.equal(
    fixture.service.getSnapshotForTarget("extension:kimi-code").notices[0]
      ?.phase,
    "completed"
  );
  fixture.dispose();
});

test("converges an Extension update when the success response is lost", async () => {
  const fixture = createFixture({
    extensionUpdateAvailable: true,
    extensionUpdateThrowsAfterApply: true
  });
  fixture.service.setSurfaceEligible("node-1", true, "extension:kimi-code");
  await fixture.service.refreshForWindowActivation();
  const notice = fixture.service.getSnapshotForTarget("extension:kimi-code")
    .notices[0];

  await fixture.service.runAction({ action: "update", notice: notice! });

  assert.equal(
    fixture.service.getSnapshotForTarget("extension:kimi-code").notices[0]
      ?.phase,
    "completed"
  );
  fixture.dispose();
});

test("keeps a failed Extension update visible and retryable", async () => {
  const fixture = createFixture({
    extensionUpdateAvailable: true,
    extensionUpdateFailure: true
  });
  fixture.service.setSurfaceEligible("node-1", true, "extension:kimi-code");
  await fixture.service.refreshForWindowActivation();
  const notice = fixture.service.getSnapshotForTarget("extension:kimi-code")
    .notices[0];

  await fixture.service.runAction({ action: "update", notice: notice! });

  assert.equal(
    fixture.service.getSnapshotForTarget("extension:kimi-code").notices[0]
      ?.phase,
    "failed"
  );
  fixture.dispose();
});

const availableNotice = {
  agentTargetId: "local:codex",
  currentVersion: "1.2.3",
  latestVersion: "1.3.0",
  phase: "available" as const
};

function createFixture(
  input: {
    autoCheckEnabled?: boolean;
    completedNoticeDurationMs?: number;
    extensionUpdateAvailable?: boolean;
    extensionUpdateFailure?: boolean;
    extensionUpdateThrowsAfterApply?: boolean;
  } = {}
): {
  agentEnv: FakeAgentEnvService;
  advance(milliseconds: number): void;
  dispose(): void;
  providerStatus: FakeProviderStatusService;
  extensionUpdateRuns: Array<{
    agentTargetId: string;
    currentVersion: string;
    latestVersion: string;
  }>;
  service: DesktopAgentCLIUpdateNoticeService;
} {
  const providerStatus = new FakeProviderStatusService([createStatus("codex")]);
  const agentEnv = new FakeAgentEnvService();
  const agents = [
    createAgent({ agentTargetId: "workspace-agent-codex", name: "Workspace" }),
    createAgent({ agentTargetId: "local:codex", name: "Codex" }),
    createAgent({
      agentTargetId: "local:tutti-agent",
      name: "Tutti Agent",
      provider: "tutti-agent"
    })
  ];
  if (input.extensionUpdateAvailable) {
    agents.push(
      createAgent({
        agentTargetId: "extension:kimi-code",
        name: "Kimi Code",
        provider: "acp:kimi-code",
        setupKind: "target_runtime"
      })
    );
  }
  const agentsService = new FakeAgentsService(agents);
  const desktopPreferencesService = {
    store: proxy({
      agentCliUpdateCheckEnabled: input.autoCheckEnabled ?? true
    })
  } as unknown as IDesktopPreferencesService;
  let now = 0;
  const extensionUpdateRuns: Array<{
    agentTargetId: string;
    currentVersion: string;
    latestVersion: string;
  }> = [];
  let extensionUpdateApplied = false;
  const service = new DesktopAgentCLIUpdateNoticeService({
    agentEnvService: agentEnv as unknown as IAgentEnvService,
    agentsService: agentsService as unknown as IAgentsService,
    completedNoticeDurationMs: input.completedNoticeDurationMs ?? 60_000,
    desktopPreferencesService,
    now: () => now,
    providerStatusService:
      providerStatus as unknown as IAgentProviderStatusService,
    tuttidClient: {
      async getAgentTargetRuntimeUpdate(_workspaceId, agentTargetId) {
        if (
          input.extensionUpdateAvailable &&
          agentTargetId === "extension:kimi-code"
        ) {
          if (extensionUpdateApplied) {
            return {
              workspaceId: "workspace-1",
              agentTargetId,
              available: false,
              currentVersion: "1.50.0",
              latestVersion: "1.50.0"
            };
          }
          return {
            workspaceId: "workspace-1",
            agentTargetId,
            available: true,
            currentVersion: "1.49.0",
            latestVersion: "1.50.0"
          };
        }
        return {
          workspaceId: "workspace-1",
          agentTargetId,
          available: false,
          currentVersion: null,
          latestVersion: null
        };
      },
      async updateAgentTargetRuntime(_workspaceId, agentTargetId, request) {
        extensionUpdateRuns.push({ agentTargetId, ...request });
        if (input.extensionUpdateFailure) {
          throw new Error("update failed");
        }
        extensionUpdateApplied = true;
        if (input.extensionUpdateThrowsAfterApply) {
          throw new Error("response lost after update");
        }
        return {
          workspaceId: "workspace-1",
          agentTargetId,
          available: false,
          currentVersion: request.latestVersion,
          latestVersion: request.latestVersion
        };
      }
    },
    workspaceId: "workspace-1"
  });
  return {
    agentEnv,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    extensionUpdateRuns,
    dispose: () => service.dispose(),
    providerStatus,
    service
  };
}

class FakeAgentEnvService {
  readonly opens: unknown[] = [];

  open(input: unknown): void {
    this.opens.push(input);
  }
}

class FakeAgentsService {
  private readonly listeners = new Set<() => void>();
  private readonly agents: readonly AgentGUIAgent[];

  constructor(agents: readonly AgentGUIAgent[]) {
    this.agents = agents;
  }

  getSnapshot() {
    return {
      agents: this.agents,
      agentTargets: [],
      capturedAtUnixMs: 1,
      error: null,
      status: "ready" as const
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class FakeProviderStatusService {
  readonly actionRuns: WorkspaceAgentProvider[] = [];
  ensureLoadedCalls = 0;
  actionMode: "success" | "failure" = "success";
  private readonly listeners = new Set<() => void>();
  private snapshot: AgentProviderStatusSnapshot;

  constructor(statuses: readonly AgentProviderStatus[]) {
    this.snapshot = createProviderSnapshot(statuses);
  }

  getSnapshot = (): AgentProviderStatusSnapshot => this.snapshot;

  getStatus(provider: WorkspaceAgentProvider): AgentProviderStatus | null {
    return (
      this.snapshot.statuses.find((status) => status.provider === provider) ??
      null
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ensureLoaded() {
    this.ensureLoadedCalls += 1;
    return {
      capturedAt: this.snapshot.capturedAt ?? "",
      defaultProvider: this.snapshot.defaultProvider ?? "codex",
      providers: [...this.snapshot.statuses]
    };
  }

  async runAction(provider: WorkspaceAgentProvider): Promise<void> {
    this.actionRuns.push(provider);
    if (this.actionMode === "failure") {
      throw new Error("update failed");
    }
    this.setStatuses([createStatus(provider, { updateAvailable: false })]);
  }

  setStatuses(statuses: readonly AgentProviderStatus[]): void {
    this.snapshot = createProviderSnapshot(statuses);
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function createProviderSnapshot(
  statuses: readonly AgentProviderStatus[]
): AgentProviderStatusSnapshot {
  return {
    capturedAt: "2026-08-04T00:00:00Z",
    defaultProvider: "codex",
    error: null,
    isLoading: false,
    pendingActions: [],
    statuses
  };
}

function createStatus(
  provider: WorkspaceAgentProvider,
  overrides: { updateAvailable?: boolean | null } = {}
): AgentProviderStatus {
  const updateAvailable = overrides.updateAvailable ?? true;
  return {
    provider,
    availability: { status: "ready", reasonCode: null },
    cli: {
      detected: true,
      installed: true,
      path: "/usr/local/bin/agent",
      version: updateAvailable ? "1.2.3" : "1.3.0",
      reasonCode: null
    },
    adapter: { available: true, reasonCode: null },
    auth: { status: "authenticated", accountLabel: null, reasonCode: null },
    update: {
      capability: "supported",
      source: "npm",
      currentVersion: updateAvailable ? "1.2.3" : "1.3.0",
      latestVersion: "1.3.0",
      updateAvailable,
      unsupportedReason: null,
      lastCheckedAt: "2026-08-04T00:00:00Z",
      reasonCode: null
    },
    actions: updateAvailable ? [{ id: "update", kind: "daemon_action" }] : []
  } as unknown as AgentProviderStatus;
}

function createAgent(
  overrides: Partial<AgentGUIAgent> &
    Pick<AgentGUIAgent, "agentTargetId" | "name">
): AgentGUIAgent {
  return {
    availability: { status: "ready" },
    iconUrl: "agent.svg",
    ownership: "self",
    provider: "codex",
    ...overrides
  };
}
