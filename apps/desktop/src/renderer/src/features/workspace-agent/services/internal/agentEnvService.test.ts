import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type {
  OpenAgentEnvPanelInput,
  StageActionId
} from "@tutti-os/agent-gui/agent-env";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type {
  AgentProviderStatusActionOptions,
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../agentProviderStatusService.interface.ts";
import { AgentEnvService } from "./agentEnvService.ts";

class FakeProviderStatusService implements IAgentProviderStatusService {
  readonly _serviceBrand: undefined;
  readonly actionCalls: Array<{
    actionId: string;
    options: AgentProviderStatusActionOptions | undefined;
    provider: WorkspaceAgentProvider;
  }> = [];
  readonly listeners = new Set<() => void>();
  readonly ensureLoadedInputs: Parameters<
    IAgentProviderStatusService["ensureLoaded"]
  > = [];
  readonly refreshInputs: Array<
    Parameters<IAgentProviderStatusService["refresh"]>
  > = [];
  refreshCalls = 0;
  ensureLoadedCalls = 0;
  reportCalls = 0;
  consent = false;
  snapshot: AgentProviderStatusSnapshot;

  constructor(status: AgentProviderStatus) {
    this.snapshot = {
      capturedAt: "2026-07-18T00:00:00Z",
      defaultProvider: status.provider,
      error: null,
      isLoading: false,
      pendingActions: [],
      statuses: [status]
    };
  }

  getRevision(): number {
    return 1;
  }
  getSnapshot(): AgentProviderStatusSnapshot {
    return this.snapshot;
  }
  getStatus(provider: WorkspaceAgentProvider): AgentProviderStatus | null {
    return (
      this.snapshot.statuses.find((item) => item.provider === provider) ?? null
    );
  }
  isActionPending(provider: WorkspaceAgentProvider, actionId: string): boolean {
    return this.snapshot.pendingActions.some(
      (item) => item.provider === provider && item.actionId === actionId
    );
  }
  isCheckingUpdates(): boolean {
    return false;
  }
  hydrate(): void {}
  async ensureLoaded(
    input?: Parameters<IAgentProviderStatusService["ensureLoaded"]>[0]
  ): Promise<null> {
    this.ensureLoadedCalls += 1;
    this.ensureLoadedInputs[0] = input;
    return null;
  }
  async reconcileStatuses(): Promise<null> {
    return null;
  }
  async runAction(
    provider: WorkspaceAgentProvider,
    actionId: string,
    options?: AgentProviderStatusActionOptions
  ): Promise<void> {
    this.actionCalls.push({ actionId, options, provider });
  }
  async refresh(
    ...input: Parameters<IAgentProviderStatusService["refresh"]>
  ): Promise<void> {
    this.refreshCalls += 1;
    this.refreshInputs.push(input);
  }
  async checkUpdates(): Promise<void> {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getDiagnosticsConsent(): boolean {
    return this.consent;
  }
  setDiagnosticsConsent(value: boolean): void {
    this.consent = value;
  }
  async reportEnvIssue(): Promise<void> {
    this.reportCalls += 1;
  }
  dispose(): void {
    this.listeners.clear();
  }
  emit(status = this.snapshot.statuses[0]): void {
    this.snapshot = {
      ...this.snapshot,
      statuses: status ? [{ ...status }] : []
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function authRequiredStatus(): AgentProviderStatus {
  return {
    provider: "claude-code",
    availability: { status: "auth_required", reasonCode: "auth_required" },
    cli: {
      installed: true,
      version: "1.0.0",
      binaryPath: "/claude",
      minVersion: "1.0.0"
    },
    adapter: {
      installed: true,
      command: ["claude", "--acp"],
      version: "1.0.0",
      requiredVersion: "1.0.0",
      binaryPath: "/claude"
    },
    auth: { status: "required", accountLabel: null },
    actions: [
      {
        command: { cwd: "/workspace", input: "claude auth login\n" },
        id: "login",
        kind: "terminal_command"
      }
    ],
    network: null,
    activeAction: null
  } as AgentProviderStatus;
}

function anomalyStatus(): AgentProviderStatus {
  return {
    ...authRequiredStatus(),
    availability: {
      status: "unsupported",
      reasonCode: "acp_adapter_version_mismatch"
    },
    adapter: {
      installed: true,
      command: ["claude", "--acp"],
      version: "1.0.0",
      requiredVersion: "2.0.0",
      binaryPath: "/claude"
    }
  } as AgentProviderStatus;
}

function createHarness(
  status: AgentProviderStatus,
  focus: OpenAgentEnvPanelInput["focus"]
) {
  const providerStatusService = new FakeProviderStatusService(status);
  const service = new AgentEnvService({
    clipboard: { writeText: async () => {} },
    providerStatusService,
    scheduler: {
      clearTimeout: () => {},
      setTimeout: () => 1
    },
    workspaceId: "workspace-1"
  });
  service.open({ focus, provider: status.provider });
  return {
    providerStatusService,
    service,
    openNewRequest() {
      service.open({ focus, provider: status.provider });
    }
  };
}

test("one auth request launches once across repeated provider status ticks", async () => {
  const harness = createHarness(authRequiredStatus(), "auth");
  const releaseHost = harness.service.bindWorkbenchHost(
    {} as WorkbenchHostHandle
  );

  for (let index = 0; index < 60; index += 1) {
    harness.providerStatusService.emit();
  }
  await flushAsyncWork();

  assert.equal(harness.providerStatusService.actionCalls.length, 1);
  assert.equal(
    harness.providerStatusService.actionCalls[0]?.options?.origin,
    "automatic"
  );
  releaseHost();
  harness.service.dispose();
});

test("a new request sequence starts one new session action", async () => {
  const harness = createHarness(authRequiredStatus(), "auth");
  harness.service.bindWorkbenchHost({} as WorkbenchHostHandle);
  await flushAsyncWork();

  harness.openNewRequest();
  for (let index = 0; index < 10; index += 1) {
    harness.providerStatusService.emit();
  }
  await flushAsyncWork();

  assert.equal(harness.providerStatusService.actionCalls.length, 2);
  harness.service.dispose();
});

test("status churn does not reset anomaly consent or local panel state", async () => {
  const harness = createHarness(anomalyStatus(), "detect");
  assert.equal(harness.service.getSnapshot().reportState, "confirming");

  harness.service.dismissReport();
  harness.service.toggleLog();
  await harness.service.copyManual("command");
  for (let index = 0; index < 20; index += 1) {
    harness.providerStatusService.emit(anomalyStatus());
  }

  assert.equal(harness.service.getSnapshot().reportState, "dismissed");
  assert.equal(harness.service.getSnapshot().logExpanded, true);
  assert.equal(harness.service.getSnapshot().copied, true);
  harness.service.dispose();
});

test("manual stage actions are marked as user-originated", async () => {
  const harness = createHarness(authRequiredStatus(), null);
  harness.service.bindWorkbenchHost({} as WorkbenchHostHandle);

  await harness.service.runStageAction("login" satisfies StageActionId);

  assert.equal(
    harness.providerStatusService.actionCalls.at(-1)?.options?.origin,
    "user"
  );
  harness.service.dispose();
});

test("environment setup owns update discovery, pending state, and execution", async () => {
  const harness = createHarness(authRequiredStatus(), null);

  assert.deepEqual(harness.providerStatusService.ensureLoadedInputs[0], {
    includeNetwork: true,
    includeUpdates: true,
    providers: ["claude-code"]
  });

  harness.providerStatusService.snapshot = {
    ...harness.providerStatusService.snapshot,
    pendingActions: [{ actionId: "update", provider: "claude-code" }]
  };
  harness.providerStatusService.emit();
  assert.equal(harness.service.getSnapshot().updatePending, true);

  await harness.service.runStageAction("update" satisfies StageActionId);
  assert.equal(
    harness.providerStatusService.actionCalls.at(-1)?.actionId,
    "update"
  );
  harness.service.dispose();
});

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
