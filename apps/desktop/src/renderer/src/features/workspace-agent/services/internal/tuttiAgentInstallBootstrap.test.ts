import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import {
  resetManagedAgentInstallBootstrapForTests,
  runManagedAgentInstallBootstrap,
  startManagedAgentInstallBootstraps,
  type ManagedAgentInstallBootstrapStorage
} from "./tuttiAgentInstallBootstrap.ts";

test("runTuttiAgentInstallBootstrap installs tutti-agent when missing", async () => {
  const calls: string[] = [];
  const status = createStatus("not_installed", [
    { id: "install", kind: "daemon_action" }
  ]);
  const service = createService(status, {
    ensureLoaded: () => calls.push("ensureLoaded"),
    refresh: () => calls.push("refresh"),
    runAction: () => calls.push("runAction")
  });

  await runManagedAgentInstallBootstrap(service, "tutti-agent", {
    now: () => 1_000,
    storage: createMemoryStorage()
  });

  assert.deepEqual(calls, ["ensureLoaded", "runAction", "refresh"]);
});

test("runTuttiAgentInstallBootstrap skips ready tutti-agent", async () => {
  const calls: string[] = [];
  const service = createService(createStatus("ready"), {
    ensureLoaded: () => calls.push("ensureLoaded"),
    runAction: () => calls.push("runAction")
  });

  await runManagedAgentInstallBootstrap(service, "tutti-agent", {
    now: () => 1_000,
    storage: createMemoryStorage()
  });

  assert.deepEqual(calls, ["ensureLoaded"]);
});

test("runTuttiAgentInstallBootstrap backs off after recent install failure", async () => {
  const calls: string[] = [];
  const storage = createMemoryStorage();
  storage.setItem(
    "tutti.agentBootstrap.tutti-agent",
    JSON.stringify({
      lastAttemptAt: 1_000,
      lastStatus: "failed",
      packageVersion: "latest"
    })
  );
  const service = createService(
    createStatus("not_installed", [{ id: "install", kind: "daemon_action" }]),
    {
      ensureLoaded: () => calls.push("ensureLoaded"),
      runAction: () => calls.push("runAction")
    }
  );

  await runManagedAgentInstallBootstrap(service, "tutti-agent", {
    backoffMs: 10_000,
    now: () => 5_000,
    storage
  });

  assert.deepEqual(calls, []);
});

test("startTuttiAgentInstallBootstrap coalesces concurrent session starts", async () => {
  resetManagedAgentInstallBootstrapForTests();
  const calls: string[] = [];
  const releaseEnsureLoaded = deferred<void>();
  const service = createService(
    createStatus("not_installed", [{ id: "install", kind: "daemon_action" }]),
    {
      ensureLoaded: async () => {
        calls.push("ensureLoaded");
        await releaseEnsureLoaded.promise;
      },
      refresh: () => calls.push("refresh"),
      runAction: () => calls.push("runAction")
    }
  );

  startManagedAgentInstallBootstraps(service, {
    now: () => 1_000,
    storage: createMemoryStorage()
  });
  startManagedAgentInstallBootstraps(service, {
    now: () => 1_000,
    storage: createMemoryStorage()
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["ensureLoaded"]);

  releaseEnsureLoaded.resolve();
  await nextTick();

  assert.deepEqual(calls, ["ensureLoaded", "runAction", "refresh"]);
  resetManagedAgentInstallBootstrapForTests();
});

function createService(
  status: AgentProviderStatus,
  hooks: {
    ensureLoaded?: () => Promise<unknown> | unknown;
    refresh?: () => void;
    runAction?: () => void;
  } = {}
): IAgentProviderStatusService {
  return {
    _serviceBrand: undefined,
    dispose: () => {},
    ensureLoaded: async () => {
      await hooks.ensureLoaded?.();
      return {
        capturedAt: "2026-07-06T00:00:00.000Z",
        defaultProvider: "tutti-agent",
        providers: [status]
      };
    },
    getDiagnosticsConsent: () => false,
    getRevision: () => 0,
    getSnapshot: () => ({
      capturedAt: "2026-07-06T00:00:00.000Z",
      defaultProvider: "tutti-agent",
      error: null,
      isLoading: false,
      pendingActions: [],
      statuses: [status]
    }),
    getStatus: () => status,
    hydrate: () => {},
    isActionPending: () => false,
    refresh: async () => {
      hooks.refresh?.();
    },
    reportEnvIssue: async () => {},
    runAction: async () => {
      hooks.runAction?.();
    },
    setDiagnosticsConsent: () => {},
    subscribe: () => () => {}
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createStatus(
  availability: AgentProviderStatus["availability"]["status"],
  actions: AgentProviderStatus["actions"] = []
): AgentProviderStatus {
  return {
    actions,
    adapter: {
      command: ["tutti-agent", "app-server"],
      installed: availability !== "not_installed"
    },
    auth: {
      status: availability === "auth_required" ? "required" : "unknown"
    },
    availability: {
      reasonCode:
        availability === "not_installed" ? "cli_not_found" : undefined,
      status: availability
    },
    cli: {
      binaryPath:
        availability === "not_installed" ? undefined : "/bin/tutti-agent",
      installed: availability !== "not_installed"
    },
    provider: "tutti-agent" satisfies WorkspaceAgentProvider
  };
}

function createMemoryStorage(): ManagedAgentInstallBootstrapStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}
