import assert from "node:assert/strict";
import test from "node:test";
import { InstantiationService } from "@tutti-os/infra/di";

import type {
  Connector,
  ConnectorMarketBackend,
  ConnectorMarketEventSource,
  ConnectorMarketSnapshot
} from "../../contracts/index.ts";
import { ConnectorMarketModule } from "./connectorMarketModule.ts";

test("module activation runs all service startup jobs before ready", async () => {
  let snapshotLoads = 0;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const module = new ConnectorMarketModule({
    market: {
      backend: backendWith({
        getSnapshot: async () => {
          snapshotLoads += 1;
          return snapshot(1, [connector("github")]);
        },
        listCategories: async () => [
          {
            categoryId: "development",
            kind: "category",
            sortOrder: 20,
            itemCount: 1
          }
        ],
        listCatalogPage: async () => ({
          sectionId: "development",
          items: [
            {
              categoryId: "development",
              featured: false,
              connector: connector("github")
            }
          ],
          revision: 1
        })
      }),
      events: eventSource({
        onSubscribe: () => {
          subscriptions += 1;
        },
        onUnsubscribe: () => {
          unsubscriptions += 1;
        }
      })
    },
    scope: {}
  });

  await module.activate(new InstantiationService());

  assert.equal(module.lifecycle.phase, "ready");
  assert.equal(snapshotLoads, 1);
  assert.equal(subscriptions, 1);
  assert.equal(module.root.uiState.dataStore.started, true);
  assert.equal(module.root.view.dataStore.status, "ready");
  assert.deepEqual(module.root.view.dataStore.sections[0]?.connectorKeys, [
    "github"
  ]);

  module.dispose();
  assert.equal(module.lifecycle.phase, "disposed");
  assert.equal(unsubscriptions, 1);
});

test("module activation skips market requests until the host admits them", async () => {
  let requestAllowed = false;
  let snapshotLoads = 0;
  let categoryLoads = 0;
  const module = new ConnectorMarketModule({
    market: {
      backend: backendWith({
        getSnapshot: async () => {
          snapshotLoads += 1;
          return snapshot(1, []);
        },
        listCategories: async () => {
          categoryLoads += 1;
          return [];
        }
      }),
      canRequest: () => requestAllowed,
      events: eventSource({})
    },
    scope: {}
  });

  await module.activate(new InstantiationService());

  assert.equal(module.lifecycle.phase, "ready");
  assert.equal(snapshotLoads, 0);
  assert.equal(categoryLoads, 0);

  requestAllowed = true;
  await module.root.market.reload();

  assert.equal(snapshotLoads, 1);
  assert.equal(categoryLoads, 1);
  assert.equal(module.root.view.dataStore.status, "empty");
  module.dispose();
});

test("module activation remains ready when optional catalog synchronization fails", async () => {
  let unsubscriptions = 0;
  const failure = new Error("catalog unavailable");
  const module = new ConnectorMarketModule({
    market: {
      backend: backendWith({
        getSnapshot: async () => Promise.reject(failure)
      }),
      events: eventSource({
        onUnsubscribe: () => {
          unsubscriptions += 1;
        }
      })
    },
    scope: {}
  });

  await module.activate(new InstantiationService());

  assert.equal(module.lifecycle.phase, "ready");
  assert.equal(module.root.market.dataStore.loadState, "error");
  assert.equal(unsubscriptions, 0);
  module.dispose();
  assert.equal(module.lifecycle.phase, "disposed");
  assert.equal(unsubscriptions, 1);
});

test("one dialog host projects authorization and management as mutually exclusive states", async () => {
  const module = new ConnectorMarketModule({
    market: {
      backend: backendWith({
        getSnapshot: async () =>
          snapshot(1, [
            connector("github", {
              authorization: { state: "disconnected" },
              installation: {
                installedReleaseDigest:
                  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                installedReleaseId: "github@1.0.0",
                installedVersion: "1.0.0",
                state: "installed"
              }
            }),
            connector("notion", {
              authorization: { state: "connected" },
              installation: {
                installedReleaseDigest:
                  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                installedReleaseId: "notion@1.0.0",
                installedVersion: "1.0.0",
                state: "installed"
              }
            })
          ])
      }),
      events: eventSource({})
    },
    scope: {}
  });

  await module.activate(new InstantiationService());
  const dialogKind = () => module.root.view.dataStore.dialog?.kind;
  module.root.uiState.openConnector("github");
  assert.equal(dialogKind(), "authorization");

  module.root.uiState.openConnector("notion");
  assert.equal(dialogKind(), "management");

  module.root.uiState.requestUninstall("github");
  assert.equal(dialogKind(), "uninstall_confirmation");

  module.root.uiState.closeDialog();
  assert.equal(module.root.view.dataStore.dialog, null);
  module.dispose();
});

test("a failed first install remains available for retry", async () => {
  const module = new ConnectorMarketModule({
    market: {
      backend: backendWith({
        getSnapshot: async () =>
          snapshot(1, [
            connector("github", {
              installation: {
                failureCode: "artifact_download_failed",
                state: "failed"
              }
            })
          ])
      }),
      events: eventSource({})
    },
    scope: {}
  });

  await module.activate(new InstantiationService());
  assert.equal(module.root.view.dataStore.cardsByKey.github?.action, "install");
  module.root.uiState.openConnector("github");
  assert.equal(module.root.view.dataStore.dialog?.kind, "installation");
  module.dispose();
});

function connector(key: string, overrides: Partial<Connector> = {}): Connector {
  const value: Connector = {
    authorization: { state: "not_required" },
    compatibility: { state: "supported" },
    installation: { state: "not_installed" },
    key,
    release: {
      artifact: {
        key: `connectors/${key}.tgz`,
        mediaType: "application/vnd.tutti.connector+tar+gzip",
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 1
      },
      connectorKey: key,
      manifest: {
        authorizationKind: "none",
        displayName: "GitHub",
        iconUrl: `https://cdn.example.test/tutti/connector-market/${key}/1.0.0/${key}-1.0.0-icon.svg`,
        implementation: {
          builtin: { cli: true, mcp: true, providerId: key },
          kind: "builtin"
        },
        permissions: [],
        schemaVersion: "1"
      },
      manifestDigest:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      publishedAt: "2026-08-04T00:00:00Z",
      releaseDigest:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      releaseId: `${key}@1.0.0`,
      schemaVersion: "1",
      status: "available",
      version: "1.0.0"
    },
    revision: 1
  };
  return { ...value, ...overrides };
}

function snapshot(
  revision: number,
  connectors: Connector[]
): ConnectorMarketSnapshot {
  return { catalogState: "ready", connectors, operations: [], revision };
}

function backendWith(
  overrides: Partial<ConnectorMarketBackend>
): ConnectorMarketBackend {
  const unsupported = async (): Promise<never> => {
    throw new Error("not implemented in test");
  };
  return {
    beginAuthorization: unsupported,
    cancelAuthorization: unsupported,
    disconnectAuthorization: unsupported,
    getConnector: unsupported,
    getOperation: unsupported,
    getSnapshot: async () => snapshot(0, []),
    listCategories: async () => [],
    listCatalogPage: unsupported,
    installConnector: unsupported,
    refreshCatalog: unsupported,
    uninstallConnector: unsupported,
    updateConnectorRuntime: unsupported,
    ...overrides
  };
}

function eventSource(callbacks: {
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;
}): ConnectorMarketEventSource {
  return {
    subscribe() {
      callbacks.onSubscribe?.();
      return () => callbacks.onUnsubscribe?.();
    }
  };
}
