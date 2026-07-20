import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import type {
  WorkspaceWindowLifecycle,
  WorkspaceWindowLifecycleEvent
} from "../../../../lib/workspaceWindowLifecycle.ts";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { startDesktopAgentAvailabilitySnapshotAnalytics } from "./desktopAgentAvailabilitySnapshotAnalytics.ts";

test("availability analytics waits for refreshed provider information", async () => {
  const events: ReporterEventInput[] = [];
  const lifecycle = createLifecycleHarness();
  const refresh = deferred<readonly AgentProviderStatus[] | null>();
  startDesktopAgentAvailabilitySnapshotAnalytics({
    dependencies: createDependencies(events),
    lifecycle,
    refreshStatuses: () => refresh.promise
  });

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  await Promise.resolve();
  assert.equal(events.length, 0);

  refresh.resolve([createReadyStatus("codex")]);
  await flushAsyncWork();

  const event = events.at(0);
  assert.ok(event);
  assert.equal(event.name, "agent.availability_snapshot");
  assert.equal(event.clientTS, 1_000);
  assert.equal(event.params?.provider, "codex");
  assert.equal(event.params?.trigger, "env_detected");
  assert.equal(events.length, 1);
});

test("availability analytics coalesces activations while a refresh is running", async () => {
  const events: ReporterEventInput[] = [];
  const lifecycle = createLifecycleHarness();
  const refreshes = [
    deferred<readonly AgentProviderStatus[] | null>(),
    deferred<readonly AgentProviderStatus[] | null>()
  ];
  let refreshCount = 0;
  startDesktopAgentAvailabilitySnapshotAnalytics({
    dependencies: createDependencies(events),
    lifecycle,
    refreshStatuses: () => refreshes[refreshCount++]!.promise
  });

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  lifecycle.emit({ kind: "focused", occurredAt: 2_000 });
  lifecycle.emit({ kind: "focused", occurredAt: 3_000 });
  assert.equal(refreshCount, 1);

  refreshes[0]!.resolve([createReadyStatus("codex")]);
  await flushAsyncWork();
  assert.equal(refreshCount, 2);

  refreshes[1]!.resolve([createUnavailableStatus("codex")]);
  await flushAsyncWork();

  assert.equal(refreshCount, 2);
  assert.deepEqual(
    events.map((event) => [event.clientTS, event.params?.trigger]),
    [
      [1_000, "env_detected"],
      [3_000, "config_change"]
    ]
  );
});

test("availability analytics reports unchanged status for every pageview opportunity", async () => {
  const events: ReporterEventInput[] = [];
  const lifecycle = createLifecycleHarness();
  startDesktopAgentAvailabilitySnapshotAnalytics({
    dependencies: createDependencies(events),
    lifecycle,
    async refreshStatuses() {
      return [createReadyStatus("codex")];
    }
  });

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  await flushAsyncWork();
  lifecycle.emit({ kind: "focused", occurredAt: 2_000 });
  await flushAsyncWork();

  assert.deepEqual(
    events.map((event) => [event.clientTS, event.params?.trigger]),
    [
      [1_000, "env_detected"],
      [2_000, "env_detected"]
    ]
  );
});

test("availability analytics does not report after disposal", async () => {
  const events: ReporterEventInput[] = [];
  const lifecycle = createLifecycleHarness();
  const refresh = deferred<readonly AgentProviderStatus[] | null>();
  const controller = startDesktopAgentAvailabilitySnapshotAnalytics({
    dependencies: createDependencies(events),
    lifecycle,
    refreshStatuses: () => refresh.promise
  });

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  controller.dispose();
  refresh.resolve([createReadyStatus("codex")]);
  await flushAsyncWork();

  assert.deepEqual(events, []);
});

function createDependencies(events: ReporterEventInput[]) {
  return {
    reporterService: {
      async trackEvents(nextEvents: ReporterEventInput[]) {
        events.push(...nextEvents);
      }
    },
    storage: null
  };
}

function createLifecycleHarness(): WorkspaceWindowLifecycle & {
  emit(event: WorkspaceWindowLifecycleEvent): void;
} {
  const listeners = new Set<(event: WorkspaceWindowLifecycleEvent) => void>();
  return {
    emit(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    getSnapshot: () => ({ focused: true, visibility: "visible" }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createReadyStatus(
  provider: AgentProviderStatus["provider"]
): AgentProviderStatus {
  return {
    actions: [],
    adapter: { command: [], installed: true },
    auth: { status: "authenticated" },
    availability: { status: "ready" },
    cli: { installed: true },
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

function createUnavailableStatus(
  provider: AgentProviderStatus["provider"]
): AgentProviderStatus {
  return {
    actions: [],
    adapter: { command: [], installed: true },
    auth: { status: "required" },
    availability: { status: "auth_required" },
    cli: { installed: true },
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

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
