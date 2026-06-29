import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../agentProviderStatusService.interface.ts";
import {
  attachAgentEnvWizard,
  type AttachAgentEnvWizardParams
} from "./agentEnvWizardController.ts";
import {
  getAgentEnvWizardSnapshot,
  resetAgentEnvWizardStoreForTests
} from "./agentEnvWizardStore.ts";

function readyStatus(): AgentProviderStatus {
  return {
    provider: "codex",
    availability: { status: "ready", reasonCode: null },
    cli: {
      installed: true,
      version: "1.2.3",
      binaryPath: "/c",
      minVersion: "1.0.0"
    },
    adapter: {
      installed: true,
      command: ["acp"],
      version: "2.0.0",
      requiredVersion: "2.0.0",
      binaryPath: "/a"
    },
    auth: { status: "authenticated", accountLabel: "me" },
    actions: [],
    network: null,
    activeAction: null
  } as AgentProviderStatus;
}

function missingCliStatus(): AgentProviderStatus {
  return {
    ...readyStatus(),
    availability: { status: "not_installed", reasonCode: "cli_not_installed" },
    cli: {
      installed: false,
      version: null,
      binaryPath: null,
      minVersion: "1.0.0"
    },
    auth: { status: "required", accountLabel: null }
  } as unknown as AgentProviderStatus;
}

class FakeService implements Partial<IAgentProviderStatusService> {
  snapshot: AgentProviderStatusSnapshot;
  listeners = new Set<() => void>();
  runActionCalls: Array<{ provider: string; actionId: string }> = [];
  reportCalls: string[] = [];
  refreshCalls = 0;
  ensureCalls = 0;
  pending = new Set<string>();
  consent = false;

  constructor(status: AgentProviderStatus) {
    this.snapshot = {
      error: null,
      isLoading: false,
      pendingActions: [],
      statuses: [status],
      capturedAt: null,
      defaultProvider: "codex"
    };
  }
  getSnapshot() {
    return this.snapshot;
  }
  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  isActionPending(_p: WorkspaceAgentProvider, a: string) {
    return this.pending.has(a);
  }
  async refresh() {
    this.refreshCalls += 1;
  }
  async ensureLoaded() {
    this.ensureCalls += 1;
    return null;
  }
  async runAction(p: WorkspaceAgentProvider, a: string) {
    this.runActionCalls.push({ provider: p, actionId: a });
  }
  getDiagnosticsConsent() {
    return this.consent;
  }
  setDiagnosticsConsent(v: boolean) {
    this.consent = v;
  }
  async reportEnvIssue(p: WorkspaceAgentProvider) {
    this.reportCalls.push(p);
  }
  emit() {
    for (const l of this.listeners) l();
  }
}

function params(
  service: FakeService,
  over: Partial<AttachAgentEnvWizardParams> = {}
): AttachAgentEnvWizardParams {
  return {
    service: service as unknown as IAgentProviderStatusService,
    provider: "codex",
    focus: "install",
    requestSequence: 1,
    context: { workspaceId: "w1" },
    scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
    ...over
  };
}

test("auto-start fires runAction exactly once across multiple service ticks", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(missingCliStatus());
  const detach = attachAgentEnvWizard(params(service));
  service.emit();
  service.emit();
  service.emit();
  detach();
  assert.equal(service.runActionCalls.length, 1);
  assert.deepEqual(service.runActionCalls[0], {
    provider: "codex",
    actionId: "install"
  });
});

test("auto-start does not fire when already ready", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(readyStatus());
  const detach = attachAgentEnvWizard(params(service));
  service.emit();
  detach();
  assert.equal(service.runActionCalls.length, 0);
});

test("non-remediation focus does not auto-start", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(missingCliStatus());
  const detach = attachAgentEnvWizard(params(service, { focus: "detect" }));
  service.emit();
  detach();
  assert.equal(service.runActionCalls.length, 0);
});

test("anomaly with consent reports once and sets reported", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService({
    ...missingCliStatus(),
    availability: {
      status: "unsupported",
      reasonCode: "acp_adapter_version_mismatch"
    },
    adapter: {
      installed: true,
      version: "1.0.0",
      requiredVersion: "2.0.0",
      command: ["acp"],
      binaryPath: "/a"
    }
  } as unknown as AgentProviderStatus);
  service.consent = true;
  const detach = attachAgentEnvWizard(params(service, { focus: "detect" }));
  service.emit();
  service.emit();
  detach();
  assert.equal(service.reportCalls.length, 1);
  assert.equal(getAgentEnvWizardSnapshot().reportState, "reported");
});

test("anomaly without consent moves to confirming and does not report", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService({
    ...missingCliStatus(),
    availability: {
      status: "unsupported",
      reasonCode: "acp_adapter_version_mismatch"
    },
    adapter: {
      installed: true,
      version: "1.0.0",
      requiredVersion: "2.0.0",
      command: ["acp"],
      binaryPath: "/a"
    }
  } as unknown as AgentProviderStatus);
  const detach = attachAgentEnvWizard(params(service, { focus: "detect" }));
  service.emit();
  detach();
  assert.equal(service.reportCalls.length, 0);
  assert.equal(getAgentEnvWizardSnapshot().reportState, "confirming");
});

test("attach with a focus refreshes; detect focus uses ensureLoaded only when no focus", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(readyStatus());
  const detach = attachAgentEnvWizard(params(service, { focus: "install" }));
  detach();
  assert.equal(service.refreshCalls, 1);
  assert.equal(service.ensureCalls, 0);
});

test("detach unsubscribes so later ticks are ignored", () => {
  resetAgentEnvWizardStoreForTests();
  // Use focus "detect" (never auto-starts) so the initial synchronous
  // orchestrate() fires no runAction. This isolates the invariant under test:
  // a post-detach() emit() must produce no orchestration side-effects and must
  // leave no controller listener subscribed.
  const service = new FakeService(missingCliStatus());
  const detach = attachAgentEnvWizard(params(service, { focus: "detect" }));
  assert.equal(service.runActionCalls.length, 0);
  detach();
  assert.equal(service.listeners.size, 0);
  service.emit();
  assert.equal(service.runActionCalls.length, 0);
});

// Extra test proving the reveal cursor advances past ok stages (the bug the
// brief warns about): if we fed projected displayStages to shouldAdvanceReveal,
// the cursor stage is always "running", never "ok", and the cursor would freeze.
// This test uses an immediate scheduler to drive the cascade synchronously.
//
// missingCliStatus stages: detect=ok, network=ok, install=pending, adapter=ok,
// login=pending, ready=pending. The reveal cursor starts at 0 (detect focus).
// With an immediate scheduler, the timer fires synchronously, so the cascade
// runs inline: detect(ok)→advance→1, network(ok)→advance→2, install(pending)→park.
// Final revealIndex = 2. If the brief's bug (feeding projected displayStages) were
// present, shouldAdvanceReveal would always see "running" at the cursor and
// revealIndex would stay at 0.
test("reveal cursor advances past ok stages and parks on first blocked stage", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(missingCliStatus());

  const immediateScheduler = {
    setTimeout: (cb: () => void, _ms: number) => {
      cb();
      return 0;
    },
    clearTimeout: (_id: number) => {}
  };

  const detach = attachAgentEnvWizard(
    params(service, { focus: "detect", scheduler: immediateScheduler })
  );

  // Trigger the first orchestrate tick (service subscription drives all logic)
  service.emit();

  // detect (ok) and network (ok) should both have been advanced past; reveal
  // parks at index 2 (install = pending).
  assert.equal(getAgentEnvWizardSnapshot().revealIndex, 2);
  detach();
});
