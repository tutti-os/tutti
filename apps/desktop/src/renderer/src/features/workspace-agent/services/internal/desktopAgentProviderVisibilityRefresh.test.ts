import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceWindowLifecycle,
  WorkspaceWindowLifecycleEvent,
  WorkspaceWindowLifecycleSnapshot
} from "../../../../lib/workspaceWindowLifecycle.ts";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";
import { bindDesktopManagedAgentProviderVisibilityRefresh } from "./desktopAgentProviderVisibilityRefresh.ts";

test("managed provider refresh follows visible window activations", () => {
  const refreshCalls: unknown[] = [];
  const lifecycle = createLifecycleHarness();
  const dispose = bindDesktopManagedAgentProviderVisibilityRefresh(
    {
      async refresh(providers) {
        refreshCalls.push(providers);
      }
    },
    lifecycle,
    { minIntervalMs: 0 }
  );

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  lifecycle.emit({ kind: "focused", occurredAt: 2_000 });
  lifecycle.setSnapshot({ focused: false, visibility: "hidden" });
  lifecycle.emit({ kind: "focused", occurredAt: 3_000 });
  lifecycle.setSnapshot({ focused: false, visibility: "visible" });
  lifecycle.emit({
    kind: "visibility_changed",
    occurredAt: 4_000,
    visibility: "visible"
  });
  dispose();
  lifecycle.emit({ kind: "focused", occurredAt: 5_000 });

  assert.deepEqual(refreshCalls, [
    [...desktopManagedAgentProviders],
    [...desktopManagedAgentProviders]
  ]);
});

test("managed provider refresh preserves a fresh application snapshot", () => {
  const refreshCalls: unknown[] = [];
  const lifecycle = createLifecycleHarness();
  bindDesktopManagedAgentProviderVisibilityRefresh(
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
      async refresh(providers) {
        refreshCalls.push(providers);
      }
    },
    lifecycle,
    { minIntervalMs: 0 }
  );

  lifecycle.emit({
    kind: "focused",
    occurredAt: Date.parse("2026-07-16T06:00:00Z")
  });

  assert.deepEqual(refreshCalls, []);
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
