import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceWindowLifecycle,
  WorkspaceWindowLifecycleEvent,
  WorkspaceWindowLifecycleSnapshot
} from "../../../../lib/workspaceWindowLifecycle.ts";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";
import { bindDesktopManagedAgentProviderVisibilityRefresh } from "./desktopAgentProviderVisibilityRefresh.ts";

test("managed provider reconciliation serializes providers for visible window activations", async () => {
  const reconcileCalls: unknown[] = [];
  const lifecycle = createLifecycleHarness();
  const dispose = bindDesktopManagedAgentProviderVisibilityRefresh(
    {
      async reconcileStatuses(providers) {
        reconcileCalls.push(providers);
        return null;
      }
    },
    lifecycle,
    { minIntervalMs: 0 }
  );

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  lifecycle.emit({ kind: "focused", occurredAt: 2_000 });
  await flushAsyncWork();
  lifecycle.setSnapshot({ focused: false, visibility: "hidden" });
  lifecycle.emit({ kind: "focused", occurredAt: 3_000 });
  lifecycle.setSnapshot({ focused: true, visibility: "visible" });
  lifecycle.emit({
    kind: "visibility_changed",
    occurredAt: 4_000,
    visibility: "visible"
  });
  await flushAsyncWork();
  dispose();
  lifecycle.emit({ kind: "focused", occurredAt: 5_000 });

  assert.deepEqual(
    reconcileCalls,
    [...desktopManagedAgentProviders, ...desktopManagedAgentProviders].map(
      (provider) => [provider]
    )
  );
});

test("managed provider reconciliation polls every fifteen minutes only while focused and visible", async () => {
  const lifecycle = createLifecycleHarness();
  const reconcileCalls: unknown[] = [];
  const polls: Array<() => void> = [];
  let cleared = false;
  let now = Date.parse("2026-07-16T06:00:00Z");
  const dispose = bindDesktopManagedAgentProviderVisibilityRefresh(
    {
      getSnapshot() {
        return {
          capturedAt: "2026-07-16T05:45:00Z",
          defaultProvider: "cursor",
          error: null,
          isLoading: false,
          pendingActions: [],
          statuses: []
        };
      },
      async reconcileStatuses(providers) {
        reconcileCalls.push(providers);
        return null;
      }
    },
    lifecycle,
    {
      minIntervalMs: 0,
      now: () => now,
      setInterval(callback, delayMs) {
        assert.equal(delayMs, 15 * 60 * 1_000);
        polls.push(callback);
        return 1;
      },
      clearInterval(timer) {
        assert.equal(timer, 1);
        cleared = true;
      }
    }
  );

  assert.equal(polls.length, 1);
  polls[0]?.();
  await flushAsyncWork();
  assert.deepEqual(
    reconcileCalls,
    desktopManagedAgentProviders.map((provider) => [provider])
  );

  lifecycle.setSnapshot({ focused: false, visibility: "visible" });
  now += 15 * 60 * 1_000;
  polls[0]?.();
  await flushAsyncWork();
  assert.equal(reconcileCalls.length, desktopManagedAgentProviders.length);

  dispose();
  assert.equal(cleared, true);
});

test("managed provider reconciliation preserves a fresh application snapshot", async () => {
  const reconcileCalls: unknown[] = [];
  const lifecycle = createLifecycleHarness();
  bindDesktopManagedAgentProviderVisibilityRefresh(
    {
      getSnapshot() {
        return {
          capturedAt: "2026-07-16T05:50:00Z",
          defaultProvider: "cursor",
          error: null,
          isLoading: false,
          pendingActions: [],
          statuses: []
        };
      },
      async reconcileStatuses(providers) {
        reconcileCalls.push(providers);
        return null;
      }
    },
    lifecycle,
    { minIntervalMs: 0 }
  );

  lifecycle.emit({
    kind: "focused",
    occurredAt: Date.parse("2026-07-16T06:00:00Z")
  });
  await flushAsyncWork();

  assert.deepEqual(reconcileCalls, []);
});

test("managed provider reconciliation stops scheduling when the window hides", async () => {
  const lifecycle = createLifecycleHarness();
  const reconcileCalls: unknown[] = [];
  const firstProvider = deferred<void>();
  bindDesktopManagedAgentProviderVisibilityRefresh(
    {
      async reconcileStatuses(providers) {
        reconcileCalls.push(providers);
        if (reconcileCalls.length === 1) {
          await firstProvider.promise;
        }
        return null;
      }
    },
    lifecycle,
    { minIntervalMs: 0 }
  );

  lifecycle.emit({ kind: "focused", occurredAt: 1_000 });
  await Promise.resolve();
  lifecycle.setSnapshot({ focused: false, visibility: "hidden" });
  firstProvider.resolve();
  await flushAsyncWork();

  assert.deepEqual(reconcileCalls, [[desktopManagedAgentProviders[0]]]);
});

function createLifecycleHarness(): WorkspaceWindowLifecycle & {
  emit(event: WorkspaceWindowLifecycleEvent): void;
  setSnapshot(snapshot: WorkspaceWindowLifecycleSnapshot): void;
} {
  const listeners = new Set<(event: WorkspaceWindowLifecycleEvent) => void>();
  let snapshot: WorkspaceWindowLifecycleSnapshot = {
    focused: true,
    visibility: "visible"
  };
  return {
    emit(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    getSnapshot: () => snapshot,
    setSnapshot(nextSnapshot) {
      snapshot = nextSnapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function deferred<T>() {
  let resolve = (_value: T | PromiseLike<T>) => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
