import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import type {
  WorkspaceWindowLifecycle,
  WorkspaceWindowLifecycleEvent
} from "../../../../lib/workspaceWindowLifecycle.ts";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { startDesktopAgentAvailabilitySnapshotAnalytics } from "./desktopAgentAvailabilitySnapshotAnalytics.ts";

test("availability analytics waits for current provider information", async () => {
  const events: ReporterEventInput[] = [];
  const lifecycle = createLifecycleHarness();
  const statuses = createStatusSource();
  startDesktopAgentAvailabilitySnapshotAnalytics({
    dependencies: createDependencies(events),
    lifecycle,
    readStatuses: statuses.read,
    subscribeStatuses: statuses.subscribe
  });

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  assert.equal(events.length, 0);

  statuses.set([createReadyStatus("codex")]);
  await flushAsyncWork();

  const event = events.at(0);
  assert.ok(event);
  assert.equal(event.name, "agent.availability_snapshot");
  assert.equal(event.clientTS, 1_000);
  assert.equal(event.params?.provider, "codex");
  assert.equal(event.params?.trigger, "env_detected");
  assert.equal(events.length, 1);
});

test("availability analytics preserves activations while waiting for a snapshot", async () => {
  const events: ReporterEventInput[] = [];
  const lifecycle = createLifecycleHarness();
  const statuses = createStatusSource();
  startDesktopAgentAvailabilitySnapshotAnalytics({
    dependencies: createDependencies(events),
    lifecycle,
    readStatuses: statuses.read,
    subscribeStatuses: statuses.subscribe
  });

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  lifecycle.emit({ kind: "focused", occurredAt: 2_000 });
  lifecycle.emit({ kind: "focused", occurredAt: 3_000 });

  statuses.set([createUnavailableStatus("codex")]);
  await flushAsyncWork();

  assert.deepEqual(
    events.map((event) => [event.clientTS, event.params?.trigger]),
    [
      [1_000, "env_detected"],
      [2_000, "env_detected"],
      [3_000, "env_detected"]
    ]
  );
});

test("availability analytics reports unchanged status for every pageview opportunity", async () => {
  const events: ReporterEventInput[] = [];
  const lifecycle = createLifecycleHarness();
  startDesktopAgentAvailabilitySnapshotAnalytics({
    dependencies: createDependencies(events),
    lifecycle,
    readStatuses() {
      return [createReadyStatus("codex")];
    },
    subscribeStatuses: () => () => {}
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
  const statuses = createStatusSource();
  const controller = startDesktopAgentAvailabilitySnapshotAnalytics({
    dependencies: createDependencies(events),
    lifecycle,
    readStatuses: statuses.read,
    subscribeStatuses: statuses.subscribe
  });

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  controller.dispose();
  statuses.set([createReadyStatus("codex")]);
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

function createStatusSource() {
  const listeners = new Set<() => void>();
  let value: readonly AgentProviderStatus[] | null = null;
  return {
    read: () => value,
    set(nextValue: readonly AgentProviderStatus[]) {
      value = nextValue;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
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
