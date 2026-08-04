import assert from "node:assert/strict";
import test from "node:test";

import type {
  Connector,
  ConnectorMarketBackend,
  ConnectorMarketChangedEvent,
  ConnectorMarketEventSource,
  ConnectorMarketSnapshot
} from "../contracts/index.ts";
import {
  ConnectorMarketBusyError,
  ConnectorMarketService
} from "./connectorMarketService.ts";

function connector(
  key: string,
  revision: number,
  workspaceId = "workspace-1"
): Connector {
  return {
    key,
    manifest: {
      schemaVersion: "1",
      key,
      version: "1.0.0",
      displayName: key,
      permissions: [],
      artifact: {
        key: `connectors/${key}/1.0.0.tgz`,
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 1024
      },
      implementation: { kind: "mcp_stdio" },
      authorizationKind: "none"
    },
    installation: { state: "not_installed" },
    authorization: { state: "not_required" },
    compatibility: { state: "supported" },
    workspaceBinding: { workspaceId, enabled: false },
    revision
  };
}

function snapshot(
  revision: number,
  connectors: Connector[]
): ConnectorMarketSnapshot {
  return {
    catalogState: "ready",
    connectors,
    operations: [],
    revision
  };
}

function backendWith(
  overrides: Partial<ConnectorMarketBackend>
): ConnectorMarketBackend {
  const unsupported = async (): Promise<never> => {
    throw new Error("not implemented in test");
  };
  return {
    getSnapshot: async () => snapshot(0, []),
    getConnector: unsupported,
    getOperation: unsupported,
    refreshCatalog: unsupported,
    installConnector: unsupported,
    uninstallConnector: unsupported,
    beginAuthorization: unsupported,
    disconnectAuthorization: unsupported,
    setWorkspaceEnabled: unsupported,
    ...overrides
  };
}

test("exposes commands directly on a class service and state through dataStore", async () => {
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [connector("github", 1)])
    })
  });

  await service.ensureLoaded();

  assert.deepEqual(service.dataStore.connectorKeys, ["github"]);
  assert.equal(service.dataStore.loadState, "ready");
  service.dispose();
});

test("ignores a stale workspace response after switching workspaces", async () => {
  const first = deferred<ConnectorMarketSnapshot>();
  const second = deferred<ConnectorMarketSnapshot>();
  const backend = backendWith({
    getSnapshot: async ({ workspaceId }) =>
      workspaceId === "workspace-1" ? first.promise : second.promise
  });
  const service = new ConnectorMarketService({
    backend,
    workspaceId: "workspace-1"
  });

  const initialLoad = service.ensureLoaded();
  const switchWorkspace = service.setWorkspace("workspace-2");
  second.resolve(snapshot(2, [connector("linear", 2, "workspace-2")]));
  await switchWorkspace;
  first.resolve(snapshot(1, [connector("github", 1)]));
  await initialLoad;

  assert.deepEqual(service.dataStore.connectorKeys, ["linear"]);
  assert.equal(service.dataStore.workspaceId, "workspace-2");
  service.dispose();
});

test("coalesces concurrent catalog refreshes", async () => {
  const refresh =
    deferred<Awaited<ReturnType<ConnectorMarketBackend["refreshCatalog"]>>>();
  let calls = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      refreshCatalog: async () => {
        calls += 1;
        return refresh.promise;
      }
    }),
    createRequestId: () => "request-1"
  });

  const first = service.refreshCatalog();
  const second = service.refreshCatalog();
  assert.equal(calls, 1);
  refresh.resolve({
    operation: {
      operationId: "operation-1",
      clientRequestId: "request-1",
      kind: "refresh_catalog",
      state: "accepted",
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z"
    },
    revision: 1
  });
  await Promise.all([first, second]);

  assert.equal(service.dataStore.revision, 1);
  assert.equal(service.dataStore.catalogOperation?.operationId, "operation-1");
  service.dispose();
});

test("rejects overlapping mutations for one connector", async () => {
  const install =
    deferred<Awaited<ReturnType<ConnectorMarketBackend["installConnector"]>>>();
  const service = new ConnectorMarketService({
    backend: backendWith({ installConnector: async () => install.promise }),
    createRequestId: () => "request-1"
  });

  const first = service.install("github");
  await assert.rejects(service.install("github"), ConnectorMarketBusyError);
  install.resolve({
    connector: connector("github", 1),
    operation: {
      operationId: "operation-1",
      clientRequestId: "request-1",
      connectorKey: "github",
      kind: "install",
      state: "accepted",
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z"
    },
    revision: 1
  });
  await first;

  assert.equal(
    service.dataStore.operationsByConnectorKey.github?.operationId,
    "operation-1"
  );
  service.dispose();
});

test("rolls back optimistic workspace enablement when the daemon rejects it", async () => {
  const update =
    deferred<
      Awaited<ReturnType<ConnectorMarketBackend["setWorkspaceEnabled"]>>
    >();
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [connector("github", 1)]),
      setWorkspaceEnabled: async () => update.promise
    }),
    workspaceId: "workspace-1"
  });
  await service.ensureLoaded();

  const mutation = service.setWorkspaceEnabled("github", true);
  assert.equal(
    service.dataStore.connectorsByKey.github?.workspaceBinding?.enabled,
    true
  );
  update.reject(new Error("daemon rejected mutation"));
  await assert.rejects(mutation, /daemon rejected mutation/);

  assert.equal(
    service.dataStore.connectorsByKey.github?.workspaceBinding?.enabled,
    false
  );
  service.dispose();
});

test("connects events only during start and disposes the subscription once", async () => {
  const events = new TestEventSource();
  let revision = 1;
  let loads = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        loads += 1;
        return snapshot(revision, [connector("github", revision)]);
      }
    }),
    events
  });
  await service.ensureLoaded();

  revision = 2;
  events.emit({ type: "connector.market.changed", revision: 2 });
  await Promise.resolve();
  assert.equal(loads, 1);

  service.start();
  service.start();
  events.emit({ type: "connector.market.changed", revision: 2 });
  await waitFor(() => service.dataStore.revision === 2);
  assert.equal(loads, 2);
  assert.equal(events.subscribeCalls, 1);

  service.dispose();
  service.dispose();
  assert.equal(events.unsubscribeCalls, 1);
  revision = 3;
  events.emit({ type: "connector.market.changed", revision: 3 });
  await Promise.resolve();
  assert.equal(loads, 2);
});

test("does not publish an in-flight response after disposal", async () => {
  const pending = deferred<ConnectorMarketSnapshot>();
  const service = new ConnectorMarketService({
    backend: backendWith({ getSnapshot: async () => pending.promise })
  });

  const load = service.ensureLoaded();
  service.dispose();
  pending.resolve(snapshot(1, [connector("github", 1)]));
  await load;

  assert.deepEqual(service.dataStore.connectorKeys, []);
  assert.equal(service.dataStore.loadState, "idle");
  assert.equal(service.dataStore.workspaceId, undefined);
});

class TestEventSource implements ConnectorMarketEventSource {
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  private listener?: (event: ConnectorMarketChangedEvent) => void;

  subscribe(listener: (event: ConnectorMarketChangedEvent) => void) {
    this.subscribeCalls += 1;
    this.listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      this.listener = undefined;
    };
  }

  emit(event: ConnectorMarketChangedEvent) {
    this.listener?.(event);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not met");
}
