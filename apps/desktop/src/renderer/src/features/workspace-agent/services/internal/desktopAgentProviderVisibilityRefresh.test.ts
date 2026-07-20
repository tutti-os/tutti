import assert from "node:assert/strict";
import test from "node:test";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";
import { bindDesktopManagedAgentProviderVisibilityRefresh } from "./desktopAgentProviderVisibilityRefresh.ts";

test("bindDesktopManagedAgentProviderVisibilityRefresh refreshes managed providers on focus", () => {
  const refreshCalls: unknown[] = [];
  let visibilityState: DocumentVisibilityState = "visible";
  const listeners = new Map<string, Set<() => void>>();

  const documentStub = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(type: string, listener: () => void) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    }
  };
  const windowStub = {
    addEventListener(type: string, listener: () => void) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    }
  };

  const dispose = bindDesktopManagedAgentProviderVisibilityRefresh(
    {
      async refresh(providers) {
        refreshCalls.push(providers);
      }
    },
    {
      document: documentStub as Pick<
        Document,
        "addEventListener" | "removeEventListener" | "visibilityState"
      >,
      minIntervalMs: 0,
      window: windowStub as Pick<
        Window,
        "addEventListener" | "removeEventListener"
      >
    }
  );

  for (const listener of listeners.get("focus") ?? []) {
    listener();
  }

  assert.deepEqual(refreshCalls, [[...desktopManagedAgentProviders]]);
  dispose();
  assert.equal(listeners.get("focus")?.size, 0);
  assert.equal(listeners.get("visibilitychange")?.size, 0);
});

test("bindDesktopManagedAgentProviderVisibilityRefresh skips hidden documents", () => {
  const refreshCalls: unknown[] = [];
  const listeners = new Map<string, Set<() => void>>();

  bindDesktopManagedAgentProviderVisibilityRefresh(
    {
      async refresh(providers) {
        refreshCalls.push(providers);
      }
    },
    {
      document: {
        visibilityState: "hidden",
        addEventListener(type: string, listener: () => void) {
          const bucket = listeners.get(type) ?? new Set();
          bucket.add(listener);
          listeners.set(type, bucket);
        },
        removeEventListener(type: string, listener: () => void) {
          listeners.get(type)?.delete(listener);
        }
      } as Pick<
        Document,
        "addEventListener" | "removeEventListener" | "visibilityState"
      >,
      minIntervalMs: 0,
      window: {
        addEventListener(type: string, listener: () => void) {
          const bucket = listeners.get(type) ?? new Set();
          bucket.add(listener);
          listeners.set(type, bucket);
        },
        removeEventListener(type: string, listener: () => void) {
          listeners.get(type)?.delete(listener);
        }
      } as Pick<Window, "addEventListener" | "removeEventListener">
    }
  );

  for (const listener of listeners.get("focus") ?? []) {
    listener();
  }

  assert.deepEqual(refreshCalls, []);
});

test("bindDesktopManagedAgentProviderVisibilityRefresh keeps a fresh application snapshot", () => {
  const refreshCalls: unknown[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const now = Date.parse("2026-07-16T06:00:00Z");

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
    {
      document: {
        visibilityState: "visible",
        addEventListener(type: string, listener: () => void) {
          const bucket = listeners.get(type) ?? new Set();
          bucket.add(listener);
          listeners.set(type, bucket);
        },
        removeEventListener(type: string, listener: () => void) {
          listeners.get(type)?.delete(listener);
        }
      } as Pick<
        Document,
        "addEventListener" | "removeEventListener" | "visibilityState"
      >,
      minIntervalMs: 0,
      now: () => now,
      window: {
        addEventListener(type: string, listener: () => void) {
          const bucket = listeners.get(type) ?? new Set();
          bucket.add(listener);
          listeners.set(type, bucket);
        },
        removeEventListener(type: string, listener: () => void) {
          listeners.get(type)?.delete(listener);
        }
      } as Pick<Window, "addEventListener" | "removeEventListener">
    }
  );

  for (const listener of listeners.get("focus") ?? []) {
    listener();
  }

  assert.deepEqual(refreshCalls, []);
});
