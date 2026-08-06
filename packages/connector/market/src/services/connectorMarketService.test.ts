import assert from "node:assert/strict";
import test from "node:test";

import type {
  Connector,
  ConnectorMarketBackend,
  ConnectorMarketChangedEvent,
  ConnectorMarketEventSource,
  ConnectorMarketSnapshot,
  ConnectorOperation
} from "../contracts/index.ts";
import {
  ConnectorMarketBusyError,
  ConnectorMarketService
} from "./connectorMarketService.ts";

function connector(key: string, revision: number): Connector {
  return {
    key,
    release: {
      schemaVersion: "1",
      releaseId: `${key}@1.0.0`,
      connectorKey: key,
      version: "1.0.0",
      releaseDigest:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      manifestDigest:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      manifest: {
        schemaVersion: "1",
        displayName: key,
        iconUrl: "data:image/png;base64,iVBORw0KGgo=",
        permissions: [],
        implementation: {
          kind: "builtin",
          builtin: { providerId: key, mcp: true, cli: false }
        },
        authorizationKind: "none"
      },
      artifact: {
        key: `connectors/${key}/1.0.0.tgz`,
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 1024,
        mediaType: "application/vnd.tutti.connector+tar+gzip"
      },
      publishedAt: "2026-08-03T00:00:00Z",
      status: "available"
    },
    installation: { state: "not_installed" },
    authorization: { state: "not_required" },
    compatibility: { state: "supported" },
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
    listCategories: async () => [],
    listCatalogPage: unsupported,
    getConnector: unsupported,
    getOperation: unsupported,
    refreshCatalog: unsupported,
    installConnector: unsupported,
    uninstallConnector: unsupported,
    beginAuthorization: unsupported,
    disconnectAuthorization: unsupported,
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

test("loads server categories and appends cursor pages", async () => {
  const pageTokens: (string | undefined)[] = [];
  const service = new ConnectorMarketService({
    backend: backendWith({
      listCategories: async () => [
        {
          categoryId: "development",
          kind: "category",
          sortOrder: 20,
          itemCount: 2
        }
      ],
      listCatalogPage: async ({ pageToken }) => {
        pageTokens.push(pageToken);
        const item = connector(
          pageToken ? "linear" : "github",
          pageToken ? 2 : 1
        );
        return {
          sectionId: "development",
          items: [
            { categoryId: "development", featured: false, connector: item }
          ],
          ...(pageToken ? {} : { nextPageToken: "page-2" }),
          revision: pageToken ? 2 : 1
        };
      }
    })
  });

  await service.ensureLoaded();
  assert.deepEqual(service.dataStore.catalogSections[0]?.connectorKeys, [
    "github"
  ]);
  assert.equal(service.dataStore.catalogSections[0]?.nextPageToken, "page-2");

  await service.loadMore("development");
  assert.deepEqual(service.dataStore.catalogSections[0]?.connectorKeys, [
    "github",
    "linear"
  ]);
  assert.equal(service.dataStore.catalogSections[0]?.nextPageToken, undefined);
  assert.deepEqual(pageTokens, [undefined, "page-2"]);
  assert.equal(service.dataStore.revision, 2);
  service.dispose();
});

test("preserves daemon catalog error details for the view layer", async () => {
  const service = new ConnectorMarketService({
    backend: backendWith({
      listCategories: async () => {
        throw {
          code: "connector_manifest_invalid",
          message: "permission scope is invalid",
          retryable: false
        };
      }
    })
  });

  await assert.rejects(service.ensureLoaded());
  assert.deepEqual(service.dataStore.lastError, {
    code: "connector_manifest_invalid",
    message: "permission scope is invalid",
    retryable: false
  });
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
      attempt: 0,
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
      attempt: 0,
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

test("installs one connector with the current catalog revision", async () => {
  const installInputs: Parameters<
    ConnectorMarketBackend["installConnector"]
  >[0][] = [];
  const installed = connector("github", 1);
  installed.installation = {
    state: "installed",
    installedReleaseDigest: installed.release.releaseDigest
  };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [installed]),
      installConnector: async (input) => {
        installInputs.push(input);
        return {
          connector: installed,
          operation: {
            operationId: "operation-install-2",
            clientRequestId: "request-install-2",
            connectorKey: "github",
            kind: "install",
            state: "accepted",
            attempt: 0,
            createdAt: "2026-08-03T00:00:00Z",
            updatedAt: "2026-08-03T00:00:00Z"
          },
          revision: 2
        };
      }
    }),
    createRequestId: () => "request-1"
  });

  await service.ensureLoaded();
  await service.install("github");

  assert.deepEqual(installInputs[0], {
    connectorKey: "github",
    clientRequestId: "request-1",
    expectedRevision: 1
  });
  service.dispose();
});

test("does not let a stale authorization response overwrite a newer daemon snapshot", async () => {
  const authorization =
    deferred<
      Awaited<ReturnType<ConnectorMarketBackend["beginAuthorization"]>>
    >();
  let snapshotRevision = 1;
  const openedUrls: string[] = [];
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        const current = connector("github", snapshotRevision);
        current.authorization = {
          state: snapshotRevision === 1 ? "disconnected" : "connected"
        };
        return snapshot(snapshotRevision, [current]);
      },
      beginAuthorization: async () => authorization.promise
    }),
    openAuthorizationUrl: async (url) => {
      openedUrls.push(url);
    }
  });
  await service.ensureLoaded();

  const mutation = service.beginAuthorization("github");
  snapshotRevision = 3;
  await service.reload();
  const staleConnector = connector("github", 2);
  staleConnector.authorization = { state: "pending" };
  authorization.resolve({
    connector: staleConnector,
    operation: operation("start_authorization", 2),
    authorizationUrl: "https://authorization.example/start",
    revision: 2
  });
  await mutation;

  assert.equal(service.dataStore.revision, 3);
  assert.equal(
    service.dataStore.connectorsByKey.github?.authorization.state,
    "connected"
  );
  assert.deepEqual(openedUrls, ["https://authorization.example/start"]);
  service.dispose();
});

test("late event subscription reconciles the authoritative snapshot and disposes once", async () => {
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
  await waitFor(() => service.dataStore.revision === 2);
  events.emit({ type: "connector.market.changed", revision: 2 });
  await Promise.resolve();
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

test("reconciles connector-scoped events without reloading the catalog", async () => {
  const events = new TestEventSource();
  let snapshotCalls = 0;
  let categoryCalls = 0;
  let connectorCalls = 0;
  let operationCalls = 0;
  let current = connector("github", 1);
  let currentOperation: ConnectorOperation = {
    operationId: "operation-install-1",
    clientRequestId: "request-install-1",
    connectorKey: "github",
    kind: "install",
    state: "running",
    stage: "downloading",
    attempt: 1,
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:01Z"
  };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        snapshotCalls += 1;
        return snapshot(1, [connector("github", 1)]);
      },
      listCategories: async () => {
        categoryCalls += 1;
        return [];
      },
      getConnector: async () => {
        connectorCalls += 1;
        return current;
      },
      getOperation: async () => {
        operationCalls += 1;
        return currentOperation;
      }
    }),
    events
  });

  await service.ensureLoaded();
  service.start();
  await waitFor(() => snapshotCalls === 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  current = connector("github", 3);
  current.installation = {
    state: "failed",
    failureCode: "connector_install_failed"
  };
  currentOperation = {
    ...currentOperation,
    state: "failed",
    stage: "failed",
    updatedAt: "2026-08-03T00:00:03Z"
  };
  events.emit({
    type: "connector.market.changed",
    connectorKey: "github",
    operationId: currentOperation.operationId,
    revision: 3
  });
  await waitFor(() => service.dataStore.revision === 3);

  assert.equal(snapshotCalls, 2);
  assert.equal(categoryCalls, 2);
  assert.equal(connectorCalls, 1);
  assert.equal(operationCalls, 1);
  assert.equal(
    service.dataStore.connectorsByKey.github?.installation.state,
    "failed"
  );
  assert.equal(
    service.dataStore.operationsByConnectorKey.github?.stage,
    "failed"
  );
  service.dispose();
});

test("keeps the visible catalog ready while a background reload is pending", async () => {
  const backgroundPage =
    deferred<Awaited<ReturnType<ConnectorMarketBackend["listCatalogPage"]>>>();
  let revision = 1;
  let pageCalls = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () =>
        snapshot(revision, [connector("github", revision)]),
      listCategories: async () => [
        {
          categoryId: "development",
          kind: "category",
          sortOrder: 20,
          itemCount: 1
        }
      ],
      listCatalogPage: async () => {
        pageCalls += 1;
        if (pageCalls > 1) {
          return backgroundPage.promise;
        }
        return {
          sectionId: "development",
          items: [
            {
              categoryId: "development",
              featured: false,
              connector: connector("github", 1)
            }
          ],
          revision: 1
        };
      }
    }),
    events: new TestEventSource()
  });

  await service.ensureLoaded();
  revision = 2;
  service.start();
  await waitFor(() => pageCalls === 2);

  assert.equal(service.dataStore.loadState, "ready");
  assert.equal(service.dataStore.catalogSections[0]?.loadState, "ready");
  assert.deepEqual(service.dataStore.catalogSections[0]?.connectorKeys, [
    "github"
  ]);

  backgroundPage.resolve({
    sectionId: "development",
    items: [
      {
        categoryId: "development",
        featured: false,
        connector: connector("github", 2)
      }
    ],
    revision: 2
  });
  await waitFor(() => service.dataStore.revision === 2);
  assert.equal(service.dataStore.catalogSections[0]?.loadState, "ready");
  service.dispose();
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
});

test("reconciles on the first connection and every daemon event-stream reconnect", async () => {
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

  service.start();
  await service.ensureLoaded();
  revision = 2;
  events.emitConnection("connected");
  await waitFor(() => service.dataStore.revision === 2);
  revision = 3;
  events.emitConnection("disconnected");
  events.emitConnection("connected");
  await waitFor(() => service.dataStore.revision === 3);

  assert.equal(loads, 3);
  service.dispose();
  assert.equal(events.connectionUnsubscribeCalls, 1);
});

test("serializes loads and retries when a queued reconnect follows a failed snapshot", async () => {
  const events = new TestEventSource();
  const first = deferred<ConnectorMarketSnapshot>();
  const second = deferred<ConnectorMarketSnapshot>();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await (calls === 1 ? first.promise : second.promise);
        } finally {
          active -= 1;
        }
      }
    }),
    events
  });

  service.start();
  const load = service.ensureLoaded();
  assert.equal(calls, 1);
  events.emitConnection("connected");
  assert.equal(calls, 1);
  first.reject(new Error("connection changed during failed snapshot"));
  await waitFor(() => calls === 2);
  second.resolve(snapshot(2, [connector("github", 2)]));
  await load;

  assert.equal(maxActive, 1);
  assert.equal(service.dataStore.revision, 2);
  assert.equal(service.dataStore.loadState, "ready");
  service.dispose();
});

class TestEventSource implements ConnectorMarketEventSource {
  connectionUnsubscribeCalls = 0;
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  private listener?: (event: ConnectorMarketChangedEvent) => void;
  private connectionListener?: (state: "connected" | "disconnected") => void;

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

  subscribeConnectionState(
    listener: (state: "connected" | "disconnected") => void
  ) {
    this.connectionListener = listener;
    return () => {
      this.connectionUnsubscribeCalls += 1;
      this.connectionListener = undefined;
    };
  }

  emitConnection(state: "connected" | "disconnected") {
    this.connectionListener?.(state);
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

function operation(kind: "start_authorization", revision: number) {
  return {
    operationId: `${kind}-${revision}`,
    clientRequestId: `request-${revision}`,
    connectorKey: "github",
    kind,
    state: "accepted" as const,
    attempt: 0,
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:00Z"
  };
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
