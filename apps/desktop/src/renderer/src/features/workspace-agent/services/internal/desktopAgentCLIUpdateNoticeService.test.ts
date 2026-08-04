import assert from "node:assert/strict";
import test from "node:test";
import type { AgentGUIAgent } from "@tutti-os/agent-gui";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { proxy } from "valtio";
import type {
  WorkspaceWindowLifecycle,
  WorkspaceWindowLifecycleEvent
} from "../../../../lib/workspaceWindowLifecycle.ts";
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

test("refreshes cached discovery on later window focus without focus-spam", async () => {
  const fixture = createFixture();
  fixture.service.setSurfaceEligible("node-1", true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.providerStatus.ensureLoadedCalls, 1);

  fixture.advance(29_999);
  fixture.windowLifecycle.emit({ kind: "focused", occurredAt: 29_999 });
  assert.equal(fixture.providerStatus.ensureLoadedCalls, 1);

  fixture.advance(1);
  fixture.windowLifecycle.emit({ kind: "focused", occurredAt: 30_000 });
  assert.equal(fixture.providerStatus.ensureLoadedCalls, 2);
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
  } = {}
): {
  agentEnv: FakeAgentEnvService;
  advance(milliseconds: number): void;
  dispose(): void;
  providerStatus: FakeProviderStatusService;
  service: DesktopAgentCLIUpdateNoticeService;
  windowLifecycle: FakeWindowLifecycle;
} {
  const providerStatus = new FakeProviderStatusService([createStatus("codex")]);
  const agentEnv = new FakeAgentEnvService();
  const agentsService = new FakeAgentsService([
    createAgent({ agentTargetId: "workspace-agent-codex", name: "Workspace" }),
    createAgent({ agentTargetId: "local:codex", name: "Codex" })
  ]);
  const desktopPreferencesService = {
    store: proxy({
      agentCliUpdateCheckEnabled: input.autoCheckEnabled ?? true
    })
  } as unknown as IDesktopPreferencesService;
  const windowLifecycle = new FakeWindowLifecycle();
  let now = 0;
  const service = new DesktopAgentCLIUpdateNoticeService({
    agentEnvService: agentEnv as unknown as IAgentEnvService,
    agentsService: agentsService as unknown as IAgentsService,
    completedNoticeDurationMs: input.completedNoticeDurationMs ?? 60_000,
    desktopPreferencesService,
    now: () => now,
    providerStatusService:
      providerStatus as unknown as IAgentProviderStatusService,
    windowLifecycle,
    workspaceId: "workspace-1"
  });
  return {
    agentEnv,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    dispose: () => service.dispose(),
    providerStatus,
    service,
    windowLifecycle
  };
}

class FakeAgentEnvService {
  readonly opens: unknown[] = [];

  open(input: unknown): void {
    this.opens.push(input);
  }
}

class FakeWindowLifecycle implements WorkspaceWindowLifecycle {
  private readonly listeners = new Set<
    (event: WorkspaceWindowLifecycleEvent) => void
  >();

  getSnapshot() {
    return { focused: true, visibility: "visible" as const };
  }

  subscribe(
    listener: (event: WorkspaceWindowLifecycleEvent) => void
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: WorkspaceWindowLifecycleEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
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

  async ensureLoaded(): Promise<null> {
    this.ensureLoadedCalls += 1;
    return null;
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
