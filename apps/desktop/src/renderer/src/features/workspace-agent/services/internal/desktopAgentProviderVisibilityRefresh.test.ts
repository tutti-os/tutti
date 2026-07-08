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

  bindDesktopManagedAgentProviderVisibilityRefresh(
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
