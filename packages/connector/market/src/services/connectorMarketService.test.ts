import assert from "node:assert/strict";
import test from "node:test";

import type {
  Connector,
  ConnectorAuthorizationInput,
  ConnectorAuthorizationResult,
  ConnectorMarketBackend,
  ConnectorMarketChangedEvent,
  ConnectorMarketEventSource,
  ConnectorMarketSnapshot,
  ConnectorOperation
} from "../contracts/index.ts";
import {
  ConnectorMarketBusyError,
  ConnectorMarketRequestUnavailableError,
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
    cancelAuthorization: unsupported,
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
  const installationFilters: ("not_installed" | undefined)[] = [];
  const service = new ConnectorMarketService({
    backend: backendWith({
      listCategories: async () => [
        {
          categoryId: "developer-tools",
          kind: "category",
          sortOrder: 40,
          itemCount: 2,
          displayNameZh: "开发者工具",
          displayNameEn: "Developer Tools"
        }
      ],
      listCatalogPage: async ({ installation, pageToken }) => {
        installationFilters.push(installation);
        pageTokens.push(pageToken);
        const item = connector(
          pageToken ? "linear" : "github",
          pageToken ? 2 : 1
        );
        return {
          sectionId: "developer-tools",
          items: [
            {
              categoryId: "developer-tools",
              featured: false,
              connector: item
            }
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
  assert.equal(
    service.dataStore.catalogSections[0]?.displayNameEn,
    "Developer Tools"
  );
  assert.equal(service.dataStore.catalogSections[0]?.nextPageToken, "page-2");

  await service.loadMore("developer-tools");
  assert.deepEqual(service.dataStore.catalogSections[0]?.connectorKeys, [
    "github",
    "linear"
  ]);
  assert.equal(service.dataStore.catalogSections[0]?.nextPageToken, undefined);
  assert.deepEqual(pageTokens, [undefined, "page-2"]);
  assert.deepEqual(installationFilters, ["not_installed", "not_installed"]);
  assert.equal(service.dataStore.revision, 2);
  service.dispose();
});

test("orders opaque dynamic categories by server sort order", async () => {
  const service = new ConnectorMarketService({
    backend: backendWith({
      listCategories: async () => [
        {
          categoryId: "business-operations",
          kind: "category",
          sortOrder: 60,
          itemCount: 0,
          displayNameZh: "商业与运营",
          displayNameEn: "Business & Operations"
        },
        {
          categoryId: "communication",
          kind: "category",
          sortOrder: 30,
          itemCount: 0,
          displayNameZh: "沟通协作",
          displayNameEn: "Communication"
        }
      ]
    })
  });

  await service.ensureLoaded();

  assert.deepEqual(
    service.dataStore.catalogSections.map((section) => ({
      categoryId: section.categoryId,
      displayNameEn: section.displayNameEn
    })),
    [
      { categoryId: "communication", displayNameEn: "Communication" },
      {
        categoryId: "business-operations",
        displayNameEn: "Business & Operations"
      }
    ]
  );
  service.dispose();
});

test("automatically updates an installed connector when catalog discovery observes a new release", async () => {
  const installed = connector("github", 1);
  installed.release.releaseDigest =
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  installed.installation = {
    state: "installed",
    installedReleaseDigest: installed.release.releaseDigest,
    installedReleaseId: installed.release.releaseId,
    installedVersion: installed.release.version
  };
  const available = structuredClone(installed);
  available.release.releaseId = "github@1.1.0";
  available.release.version = "1.1.0";
  available.release.releaseDigest =
    "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  available.revision = 2;
  const updated = structuredClone(available);
  updated.installation = {
    state: "installed",
    installedReleaseDigest: available.release.releaseDigest,
    installedReleaseId: available.release.releaseId,
    installedVersion: available.release.version
  };
  updated.revision = 3;
  const installInputs: Parameters<
    ConnectorMarketBackend["installConnector"]
  >[0][] = [];
  let installAdmissionRequests = 0;
  const service = new ConnectorMarketService({
    autoUpdateInstalledConnectors: true,
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [installed]),
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
            connector: available
          }
        ],
        revision: 2
      }),
      installConnector: async (input) => {
        installInputs.push(input);
        return {
          connector: updated,
          operation: {
            operationId: "operation-auto-update",
            clientRequestId: input.clientRequestId,
            connectorKey: "github",
            kind: "install",
            state: "completed",
            stage: "completed",
            attempt: 1,
            createdAt: "2026-08-15T00:00:00Z",
            updatedAt: "2026-08-15T00:00:01Z"
          },
          revision: 3
        };
      }
    }),
    requestInstallAdmission: () => {
      installAdmissionRequests += 1;
    }
  });

  await service.ensureLoaded();
  await waitFor(() => installInputs.length === 1);

  assert.equal(installInputs[0]?.connectorKey, "github");
  assert.equal(installInputs[0]?.expectedConnectorRevision, 2);
  assert.equal(installAdmissionRequests, 0);
  assert.equal(
    service.dataStore.connectorsByKey.github?.installation
      .installedReleaseDigest,
    available.release.releaseDigest
  );
  service.dispose();
});

test("attempts automatic update only once for the same failed release", async () => {
  const installed = connector("github", 1);
  installed.installation = {
    state: "installed",
    installedReleaseDigest:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  };
  let installCalls = 0;
  const service = new ConnectorMarketService({
    autoUpdateInstalledConnectors: true,
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [installed]),
      installConnector: async () => {
        installCalls += 1;
        throw new Error("update failed");
      }
    })
  });

  await service.ensureLoaded();
  await waitFor(() => installCalls === 1);
  await service.reload();
  await Promise.resolve();

  assert.equal(installCalls, 1);
  service.dispose();
});

test("keeps healthy catalog sections available and retries a failed section", async () => {
  let otherFails = true;
  const diagnostics: unknown[] = [];
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, []),
      listCategories: async () => [
        {
          categoryId: "development",
          kind: "category",
          sortOrder: 20,
          itemCount: 1
        },
        {
          categoryId: "other",
          kind: "category",
          sortOrder: 40,
          itemCount: 1
        }
      ],
      listCatalogPage: async ({ sectionId }) => {
        if (sectionId === "other" && otherFails) {
          throw {
            code: "connector_market_upstream_unavailable",
            message: "other is unavailable",
            retryable: true
          };
        }
        const item = connector(sectionId === "other" ? "notion" : "github", 1);
        return {
          sectionId,
          items: [{ categoryId: sectionId, featured: false, connector: item }],
          revision: 1
        };
      }
    }),
    reportDiagnostic: (error) => diagnostics.push(error)
  });

  await service.ensureLoaded();

  assert.equal(service.dataStore.loadState, "ready");
  assert.deepEqual(
    service.dataStore.catalogSections.find(
      (section) => section.categoryId === "development"
    )?.connectorKeys,
    ["github"]
  );
  assert.equal(
    service.dataStore.catalogSections.find(
      (section) => section.categoryId === "other"
    )?.loadState,
    "error"
  );
  assert.equal(service.dataStore.lastError, null);

  otherFails = false;
  await service.loadMore("other");
  assert.deepEqual(
    service.dataStore.catalogSections.find(
      (section) => section.categoryId === "other"
    )?.connectorKeys,
    ["notion"]
  );

  otherFails = true;
  await service.reload();
  const staleOther = service.dataStore.catalogSections.find(
    (section) => section.categoryId === "other"
  );
  assert.equal(service.dataStore.loadState, "ready");
  assert.equal(staleOther?.loadState, "error");
  assert.deepEqual(staleOther?.connectorKeys, ["notion"]);
  assert.equal(diagnostics.length, 2);
  service.dispose();
});

test("uses the global error state when every initial catalog section fails", async () => {
  const failure = {
    code: "connector_market_upstream_unavailable",
    message: "catalog is unavailable",
    retryable: true
  };
  const service = new ConnectorMarketService({
    backend: backendWith({
      listCategories: async () => [
        {
          categoryId: "other",
          kind: "category",
          sortOrder: 40,
          itemCount: 1
        }
      ],
      listCatalogPage: async () => {
        throw failure;
      }
    })
  });

  await assert.rejects(service.ensureLoaded());
  assert.equal(service.dataStore.loadState, "error");
  assert.deepEqual(service.dataStore.lastError, failure);
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
  assert.equal(
    service.dataStore.pendingInstallationsByConnectorKey.github,
    true
  );
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
    service.dataStore.pendingInstallationsByConnectorKey.github,
    undefined
  );
  assert.equal(
    service.dataStore.operationsByConnectorKey.github?.operationId,
    "operation-1"
  );
  service.dispose();
});

test("requests host admission instead of installing when account access is unavailable", async () => {
  let admitted = false;
  let admissionRequests = 0;
  let installCalls = 0;
  const installed = connector("github", 1);
  installed.installation = {
    state: "installed",
    installedReleaseDigest: installed.release.releaseDigest
  };
  const service = new ConnectorMarketService({
    backend: backendWith({
      installConnector: async () => {
        installCalls += 1;
        return {
          connector: installed,
          operation: {
            operationId: "operation-install-1",
            clientRequestId: "request-install-1",
            connectorKey: "github",
            kind: "install",
            state: "completed",
            stage: "completed",
            attempt: 1,
            createdAt: "2026-08-03T00:00:00Z",
            updatedAt: "2026-08-03T00:00:01Z"
          },
          revision: 1
        };
      }
    }),
    canRequest: () => admitted,
    requestInstallAdmission: () => {
      admissionRequests += 1;
    }
  });

  assert.equal(await service.install("github"), "not_admitted");
  assert.equal(admissionRequests, 1);
  assert.equal(installCalls, 0);
  assert.deepEqual(service.dataStore.pendingInstallationsByConnectorKey, {});

  admitted = true;
  assert.equal(await service.install("github"), "installed");
  assert.equal(admissionRequests, 1);
  assert.equal(installCalls, 1);
  service.dispose();
});

test("clears the projected pending installation when install fails", async () => {
  const install = deferred<never>();
  const service = new ConnectorMarketService({
    backend: backendWith({ installConnector: async () => install.promise })
  });

  const pending = service.install("github");
  assert.equal(
    service.dataStore.pendingInstallationsByConnectorKey.github,
    true
  );
  install.reject(new Error("install failed"));
  await assert.rejects(pending, /install failed/);

  assert.equal(
    service.dataStore.pendingInstallationsByConnectorKey.github,
    undefined
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
    expectedRevision: 1,
    expectedConnectorRevision: 1
  });
  service.dispose();
});

test("does not resolve install success when an accepted operation later fails", async () => {
  const acceptedConnector = connector("github", 1);
  acceptedConnector.installation = { state: "installing" };
  const failedConnector = connector("github", 3);
  failedConnector.installation = {
    state: "failed",
    failureCode: "candidate_runtime_failed"
  };
  const failedOperation: ConnectorOperation = {
    operationId: "operation-install-failed",
    clientRequestId: "request-install-failed",
    connectorKey: "github",
    kind: "install",
    state: "failed",
    stage: "failed",
    attempt: 1,
    failureCode: "candidate_runtime_failed",
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:03Z"
  };
  const service = new ConnectorMarketService({
    backend: backendWith({
      installConnector: async () => ({
        connector: acceptedConnector,
        operation: { ...failedOperation, state: "accepted", stage: "accepted" },
        revision: 2
      }),
      getOperation: async () => failedOperation,
      getConnector: async () => failedConnector
    }),
    waitForOperationPoll: async () => undefined
  });

  await assert.rejects(service.install("github"), (error: unknown) => {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "candidate_runtime_failed"
    );
  });
  service.dispose();
});

test("uninstalls one connector and tracks the durable operation to completion", async () => {
  const uninstallInputs: Parameters<
    ConnectorMarketBackend["uninstallConnector"]
  >[0][] = [];
  const installed = connector("github", 1);
  installed.installation = {
    installedReleaseDigest: installed.release.releaseDigest,
    state: "installed"
  };
  installed.authorization = { state: "connected" };
  const uninstalling = connector("github", 2);
  uninstalling.installation = {
    installedReleaseDigest: installed.release.releaseDigest,
    state: "uninstalling"
  };
  uninstalling.authorization = { state: "connected" };
  const uninstalled = connector("github", 3);
  uninstalled.installation = { state: "not_installed" };
  uninstalled.authorization = { state: "connected" };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [installed]),
      uninstallConnector: async (input) => {
        uninstallInputs.push(input);
        return {
          connector: uninstalling,
          operation: {
            operationId: "operation-uninstall-terminal",
            clientRequestId: input.clientRequestId,
            connectorKey: "github",
            kind: "uninstall",
            state: "accepted",
            stage: "accepted",
            attempt: 0,
            createdAt: "2026-08-11T00:00:00Z",
            updatedAt: "2026-08-11T00:00:00Z"
          },
          revision: 2
        };
      },
      getOperation: async () => ({
        operationId: "operation-uninstall-terminal",
        clientRequestId: "request-uninstall-1",
        connectorKey: "github",
        kind: "uninstall",
        state: "completed",
        stage: "completed",
        attempt: 1,
        createdAt: "2026-08-11T00:00:00Z",
        updatedAt: "2026-08-11T00:00:01Z"
      }),
      getConnector: async () => uninstalled
    }),
    createRequestId: () => "request-uninstall-1",
    waitForOperationPoll: async () => undefined
  });

  await service.ensureLoaded();
  const accepted = await service.uninstall("github");
  assert.equal(accepted.operationId, "operation-uninstall-terminal");
  const pendingNotification =
    service.dataStore.pendingUninstallNotificationsByOperationId[
      accepted.operationId
    ];
  assert.equal(pendingNotification?.connectorKey, "github");
  assert.equal(pendingNotification?.displayName, "github");
  assert.equal(
    pendingNotification?.operationId,
    "operation-uninstall-terminal"
  );
  await waitFor(
    () =>
      service.dataStore.connectorsByKey.github?.installation.state ===
      "not_installed"
  );

  assert.deepEqual(uninstallInputs, [
    {
      connectorKey: "github",
      clientRequestId: "request-uninstall-1",
      expectedRevision: 1,
      expectedConnectorRevision: 1
    }
  ]);
  assert.equal(
    service.dataStore.operationsByConnectorKey.github?.state,
    "completed"
  );
  assert.equal(
    service.dataStore.pendingUninstallNotificationsByOperationId[
      accepted.operationId
    ]?.state,
    "completed"
  );
  assert.equal(
    service.dataStore.connectorsByKey.github?.authorization.state,
    "connected"
  );
  service.dismissUninstallNotification(accepted.operationId);
  assert.equal(
    service.dataStore.pendingUninstallNotificationsByOperationId[
      accepted.operationId
    ],
    undefined
  );
  service.dispose();
});

test("rejects uninstall when host request admission is unavailable", async () => {
  let uninstallCalls = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      uninstallConnector: async () => {
        uninstallCalls += 1;
        throw new Error("must not be called");
      }
    }),
    canRequest: () => false
  });

  await assert.rejects(
    service.uninstall("github"),
    ConnectorMarketRequestUnavailableError
  );
  assert.equal(uninstallCalls, 0);
  assert.deepEqual(
    service.dataStore.pendingUninstallNotificationsByOperationId,
    {}
  );
  service.dispose();
});

test("polls an accepted connector operation to terminal state when its event is missed", async () => {
  const acceptedConnector = connector("github", 1);
  acceptedConnector.installation = { state: "installing" };
  const installedConnector = connector("github", 3);
  installedConnector.installation = {
    state: "installed",
    installedReleaseDigest: installedConnector.release.releaseDigest
  };
  let operationReads = 0;
  let connectorReads = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      installConnector: async () => ({
        connector: acceptedConnector,
        operation: {
          operationId: "operation-install-terminal",
          clientRequestId: "request-install-terminal",
          connectorKey: "github",
          kind: "install",
          state: "accepted",
          stage: "accepted",
          attempt: 0,
          createdAt: "2026-08-03T00:00:00Z",
          updatedAt: "2026-08-03T00:00:00Z"
        },
        revision: 1
      }),
      getOperation: async () => {
        operationReads += 1;
        return {
          operationId: "operation-install-terminal",
          clientRequestId: "request-install-terminal",
          connectorKey: "github",
          kind: "install",
          state: operationReads === 1 ? "running" : "completed",
          stage: operationReads === 1 ? "installing" : "completed",
          attempt: 1,
          createdAt: "2026-08-03T00:00:00Z",
          updatedAt: `2026-08-03T00:00:0${operationReads}Z`
        };
      },
      getConnector: async () => {
        connectorReads += 1;
        if (connectorReads === 1) {
          throw {
            code: "connector_market_unavailable",
            message: "local connector projection temporarily unavailable",
            retryable: true
          };
        }
        return installedConnector;
      }
    }),
    waitForOperationPoll: async () => undefined
  });

  await service.install("github");
  await waitFor(
    () =>
      service.dataStore.connectorsByKey.github?.installation.state ===
      "installed"
  );

  assert.equal(operationReads, 3);
  assert.equal(connectorReads, 2);
  assert.equal(
    service.dataStore.operationsByConnectorKey.github?.state,
    "completed"
  );
  assert.equal(service.dataStore.revision, 3);
  service.dispose();
});

test("stops operation polling after a permanent read error and reconciles once", async () => {
  const acceptedConnector = connector("github", 1);
  acceptedConnector.installation = { state: "installing" };
  const reconciledConnector = connector("github", 2);
  reconciledConnector.installation = {
    state: "failed",
    failureCode: "connector_install_failed"
  };
  let operationReads = 0;
  let connectorReads = 0;
  let pollWaits = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      installConnector: async () => ({
        connector: acceptedConnector,
        operation: {
          operationId: "operation-install-forbidden",
          clientRequestId: "request-install-forbidden",
          connectorKey: "github",
          kind: "install",
          state: "accepted",
          stage: "accepted",
          attempt: 0,
          createdAt: "2026-08-03T00:00:00Z",
          updatedAt: "2026-08-03T00:00:00Z"
        },
        revision: 1
      }),
      getOperation: async () => {
        operationReads += 1;
        throw {
          code: "connector_market_forbidden",
          message: "operation read forbidden",
          retryable: false
        };
      },
      getConnector: async () => {
        connectorReads += 1;
        return reconciledConnector;
      }
    }),
    waitForOperationPoll: async () => {
      pollWaits += 1;
    }
  });

  await service.install("github");
  await waitFor(() => service.dataStore.lastError !== null);
  await waitFor(
    () =>
      service.dataStore.connectorsByKey.github?.installation.state === "failed"
  );

  assert.equal(operationReads, 1);
  assert.equal(connectorReads, 1);
  assert.equal(pollWaits, 0);
  assert.deepEqual(service.dataStore.lastError, {
    code: "connector_market_forbidden",
    message: "operation read forbidden",
    retryable: false
  });
  service.dispose();
});

test("reconciles refresh completion from the local snapshot without reloading remote categories", async () => {
  let categoryCalls = 0;
  let snapshotCalls = 0;
  const completedRefreshOperation: ConnectorOperation = {
    operationId: "operation-refresh-terminal",
    clientRequestId: "request-refresh-terminal",
    kind: "refresh_catalog",
    state: "completed",
    stage: "completed",
    attempt: 1,
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:01Z"
  };
  const service = new ConnectorMarketService({
    backend: backendWith({
      refreshCatalog: async () => ({
        operation: {
          operationId: "operation-refresh-terminal",
          clientRequestId: "request-refresh-terminal",
          kind: "refresh_catalog",
          state: "accepted",
          stage: "accepted",
          attempt: 0,
          createdAt: "2026-08-03T00:00:00Z",
          updatedAt: "2026-08-03T00:00:00Z"
        },
        revision: 1
      }),
      getOperation: async () => completedRefreshOperation,
      getSnapshot: async () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          throw {
            code: "connector_market_unavailable",
            message: "local snapshot temporarily unavailable",
            retryable: true
          };
        }
        return {
          ...snapshot(2, [connector("github", 2)]),
          operations: [completedRefreshOperation]
        };
      },
      listCategories: async () => {
        categoryCalls += 1;
        throw new Error("remote categories unavailable");
      }
    }),
    waitForOperationPoll: async () => undefined
  });

  await service.refreshCatalog();
  await waitFor(() => service.dataStore.catalogState === "ready");

  assert.equal(categoryCalls, 0);
  assert.equal(snapshotCalls, 2);
  assert.equal(service.dataStore.catalogOperation?.state, "completed");
  assert.equal(service.dataStore.revision, 2);
  service.dispose();
});

test("keeps the authoritative refresh operation after a permanent read error", async () => {
  const completedRefreshOperation: ConnectorOperation = {
    operationId: "operation-refresh-forbidden",
    clientRequestId: "request-refresh-forbidden",
    kind: "refresh_catalog",
    state: "completed",
    stage: "completed",
    attempt: 1,
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:01Z"
  };
  let operationReads = 0;
  let snapshotReads = 0;
  let pollWaits = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      refreshCatalog: async () => ({
        operation: {
          ...completedRefreshOperation,
          state: "accepted",
          stage: "accepted",
          attempt: 0,
          updatedAt: "2026-08-03T00:00:00Z"
        },
        revision: 1
      }),
      getOperation: async () => {
        operationReads += 1;
        throw {
          code: "connector_market_forbidden",
          message: "refresh operation read forbidden",
          retryable: false
        };
      },
      getSnapshot: async () => {
        snapshotReads += 1;
        return {
          ...snapshot(2, [connector("github", 2)]),
          operations: [completedRefreshOperation]
        };
      }
    }),
    waitForOperationPoll: async () => {
      pollWaits += 1;
    }
  });

  await service.refreshCatalog();
  await waitFor(
    () => service.dataStore.catalogOperation?.state === "completed"
  );

  assert.equal(operationReads, 1);
  assert.equal(snapshotReads, 1);
  assert.equal(pollWaits, 0);
  assert.deepEqual(service.dataStore.lastError, {
    code: "connector_market_forbidden",
    message: "refresh operation read forbidden",
    retryable: false
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

test("forwards a user-provided secret only to the authorization mutation", async () => {
  let receivedSecret: string | undefined;
  const initial = connector("token-mail", 1);
  initial.installation = {
    state: "installed",
    installedReleaseDigest: initial.release.releaseDigest
  };
  initial.authorization = { state: "disconnected" };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [initial]),
      beginAuthorization: async (input) => {
        receivedSecret = input.secret;
        const connected = connector("token-mail", 2);
        connected.authorization = { state: "connected" };
        return {
          connector: connected,
          operation: {
            ...operation("start_authorization", 2),
            connectorKey: "token-mail",
            state: "completed"
          },
          revision: 2
        };
      }
    })
  });
  await service.ensureLoaded();

  await service.beginAuthorization("token-mail", "secret-value");

  assert.equal(receivedSecret, "secret-value");
  assert.equal(service.dataStore.revision, 2);
  service.dispose();
});

test("a new authorization command supersedes the previous caller", async () => {
  const firstAuthorization =
    deferred<
      Awaited<ReturnType<ConnectorMarketBackend["beginAuthorization"]>>
    >();
  const secondAuthorization =
    deferred<
      Awaited<ReturnType<ConnectorMarketBackend["beginAuthorization"]>>
    >();
  let authorizationAttempts = 0;
  let requestIds = 0;
  const requests: ConnectorAuthorizationInput[] = [];
  const initial = connector("notion", 1);
  initial.authorization = { state: "disconnected" };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [initial]),
      beginAuthorization: async (request) => {
        requests.push(request);
        authorizationAttempts += 1;
        return authorizationAttempts === 1
          ? firstAuthorization.promise
          : secondAuthorization.promise;
      }
    }),
    createRequestId: () => `authorization-${++requestIds}`
  });
  await service.ensureLoaded();

  const first = service.beginAuthorization("notion");
  const second = service.beginAuthorization("notion");
  const connected = connector("notion", 2);
  connected.authorization = { state: "connected" };
  secondAuthorization.resolve({
    connector: connected,
    operation: {
      ...operation("start_authorization", 2),
      connectorKey: "notion",
      state: "completed"
    },
    revision: 2
  });
  await second;
  firstAuthorization.resolve({
    connector: connected,
    operation: {
      ...operation("start_authorization", 2),
      connectorKey: "notion",
      state: "completed"
    },
    revision: 2
  });
  await assert.rejects(first, (error: unknown) =>
    Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "connector_authorization_canceled"
    )
  );

  assert.equal(authorizationAttempts, 2);
  assert.equal(requestIds, 2);
  assert.deepEqual(
    requests.map(({ clientRequestId, replacementPolicy }) => ({
      clientRequestId,
      replacementPolicy
    })),
    [
      {
        clientRequestId: "authorization-1",
        replacementPolicy: "replace_active"
      },
      {
        clientRequestId: "authorization-2",
        replacementPolicy: "replace_active"
      }
    ]
  );
  assert.deepEqual(service.dataStore.authorizingConnectorKeys, {});
  service.dispose();
});

test("converges a busy authorization continuation from a connected snapshot", async () => {
  const requests: Array<{
    clientRequestId: string;
    expectedRevision: number;
  }> = [];
  const openedUrls: string[] = [];
  let snapshotReads = 0;
  const disconnected = connector("notion", 1);
  disconnected.authorization = { state: "disconnected" };
  const connected = connector("notion", 4);
  connected.authorization = { state: "connected" };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        snapshotReads += 1;
        return snapshotReads === 1
          ? snapshot(1, [disconnected])
          : snapshot(4, [connected]);
      },
      beginAuthorization: async (request) => {
        requests.push(request);
        if (requests.length > 1) {
          throw Object.assign(new Error("runtime reconcile in progress"), {
            code: "connector_operation_in_progress",
            retryable: true
          });
        }
        const pending = connector("notion", 2);
        pending.authorization = { state: "pending" };
        return {
          connector: pending,
          operation: {
            ...operation("start_authorization", 2),
            connectorKey: "notion",
            state: "completed" as const
          },
          authorizationUrl: "https://authorization.example/notion",
          revision: 2
        };
      }
    }),
    createRequestId: () => "one-notion-authorization",
    openAuthorizationUrl: async (url) => {
      openedUrls.push(url);
    },
    waitForAuthorizationContinuation: async () => undefined
  });
  await service.ensureLoaded();

  await service.beginAuthorization("notion");

  assert.equal(snapshotReads, 2);
  assert.deepEqual(requests, [
    {
      connectorKey: "notion",
      clientRequestId: "one-notion-authorization",
      replacementPolicy: "replace_active",
      expectedRevision: 1,
      expectedConnectorRevision: 1
    },
    {
      connectorKey: "notion",
      clientRequestId: "one-notion-authorization",
      replacementPolicy: "replace_active",
      expectedRevision: 1,
      expectedConnectorRevision: 2
    }
  ]);
  assert.deepEqual(openedUrls, ["https://authorization.example/notion"]);
  assert.equal(
    service.dataStore.connectorsByKey.notion?.authorization.state,
    "connected"
  );
  assert.equal(service.dataStore.lastError, null);
  service.dispose();
});

test("recovers one stale authorization revision without dropping the secret", async () => {
  const requests: Array<{
    clientRequestId: string;
    expectedRevision: number;
    secret?: string;
  }> = [];
  let snapshotReads = 0;
  const initial = connector("token-mail", 1);
  initial.installation = {
    state: "installed",
    installedReleaseDigest: initial.release.releaseDigest
  };
  initial.authorization = { state: "disconnected" };
  const refreshed = connector("token-mail", 4);
  refreshed.installation = initial.installation;
  refreshed.authorization = initial.authorization;
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        snapshotReads += 1;
        return snapshotReads === 1
          ? snapshot(1, [initial])
          : snapshot(4, [refreshed]);
      },
      beginAuthorization: async (input) => {
        requests.push(input);
        if (requests.length === 1) {
          throw Object.assign(new Error("stale revision"), {
            code: "connector_market_revision_conflict",
            retryable: true
          });
        }
        const connected = connector("token-mail", 5);
        connected.authorization = { state: "connected" };
        return {
          connector: connected,
          operation: {
            ...operation("start_authorization", 5),
            connectorKey: "token-mail",
            state: "completed"
          },
          revision: 5
        };
      }
    }),
    createRequestId: () => "one-secret-request"
  });
  await service.ensureLoaded();

  await service.beginAuthorization("token-mail", "secret-value");

  assert.equal(snapshotReads, 2);
  assert.deepEqual(requests, [
    {
      connectorKey: "token-mail",
      clientRequestId: "one-secret-request",
      replacementPolicy: "replace_active",
      expectedRevision: 1,
      expectedConnectorRevision: 1,
      secret: "secret-value"
    },
    {
      connectorKey: "token-mail",
      clientRequestId: "one-secret-request",
      replacementPolicy: "replace_active",
      expectedRevision: 4,
      expectedConnectorRevision: 4,
      secret: "secret-value"
    }
  ]);
  assert.equal(service.dataStore.revision, 5);
  assert.equal(
    service.dataStore.connectorsByKey["token-mail"]?.authorization.state,
    "connected"
  );
  service.dispose();
});

test("does not retry authorization failures other than a stale revision", async () => {
  let snapshotReads = 0;
  let authorizationAttempts = 0;
  const disconnected = connector("token-mail", 1);
  disconnected.installation = {
    state: "installed",
    installedReleaseDigest: disconnected.release.releaseDigest
  };
  disconnected.authorization = { state: "disconnected" };
  const providerError = Object.assign(new Error("provider rejected token"), {
    code: "connector_authorization_provider_rejected",
    retryable: false
  });
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        snapshotReads += 1;
        return snapshot(1, [disconnected]);
      },
      beginAuthorization: async () => {
        authorizationAttempts += 1;
        throw providerError;
      }
    })
  });
  await service.ensureLoaded();

  await assert.rejects(
    service.beginAuthorization("token-mail", "invalid-secret"),
    providerError
  );

  assert.equal(snapshotReads, 1);
  assert.equal(authorizationAttempts, 1);
  service.dispose();
});

test("continues one authorization session, opens each URL once, and clears loading", async () => {
  const requests: Array<{ clientRequestId: string; expectedRevision: number }> =
    [];
  const openedUrls: string[] = [];
  let step = 0;
  const initial = connector("lark-cli", 1);
  initial.authorization = { state: "disconnected" };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [initial]),
      beginAuthorization: async (request) => {
        requests.push(request);
        step += 1;
        const next = connector("lark-cli", step + 1);
        next.authorization = { state: step === 3 ? "connected" : "pending" };
        return {
          connector: next,
          operation: {
            ...operation("start_authorization", step + 1),
            connectorKey: "lark-cli",
            state: "completed" as const
          },
          authorizationUrl:
            step === 2
              ? "https://accounts.feishu.cn/device?user_code=authorization"
              : "https://open.feishu.cn/page/cli?user_code=configuration",
          revision: step + 1
        };
      }
    }),
    createRequestId: () => "one-authorization-request",
    openAuthorizationUrl: async (url) => {
      openedUrls.push(url);
    }
  });
  await service.ensureLoaded();

  await service.beginAuthorization("lark-cli");

  assert.equal(step, 3);
  assert.deepEqual(requests, [
    {
      connectorKey: "lark-cli",
      clientRequestId: "one-authorization-request",
      replacementPolicy: "replace_active",
      expectedRevision: 1,
      expectedConnectorRevision: 1
    },
    {
      connectorKey: "lark-cli",
      clientRequestId: "one-authorization-request",
      replacementPolicy: "replace_active",
      expectedRevision: 1,
      expectedConnectorRevision: 2
    },
    {
      connectorKey: "lark-cli",
      clientRequestId: "one-authorization-request",
      replacementPolicy: "replace_active",
      expectedRevision: 1,
      expectedConnectorRevision: 3
    }
  ]);
  assert.deepEqual(openedUrls, [
    "https://open.feishu.cn/page/cli?user_code=configuration",
    "https://accounts.feishu.cn/device?user_code=authorization"
  ]);
  assert.equal(
    service.dataStore.connectorsByKey["lark-cli"]?.authorization.state,
    "connected"
  );
  assert.deepEqual(service.dataStore.authorizingConnectorKeys, {});
  service.dispose();
});

test("keeps a pending authorization session stable across a disconnected snapshot", async () => {
  const continuation = deferred<ConnectorAuthorizationResult>();
  const initial = connector("supabase", 1);
  initial.authorization = { state: "disconnected" };
  const refreshed = connector("supabase", 2);
  refreshed.authorization = { state: "disconnected" };
  const pending = connector("supabase", 2);
  pending.authorization = { state: "pending" };
  const connected = connector("supabase", 3);
  connected.authorization = { state: "connected" };
  let snapshotReads = 0;
  let authorizationCalls = 0;
  const authorizationOperation = {
    ...operation("start_authorization", 2),
    connectorKey: "supabase",
    operationId: "supabase-authorization",
    state: "completed" as const,
    stage: "completed" as const
  };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        snapshotReads += 1;
        return snapshot(snapshotReads === 1 ? 1 : 2, [
          snapshotReads === 1 ? initial : refreshed
        ]);
      },
      beginAuthorization: async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 1) {
          return {
            connector: pending,
            operation: authorizationOperation,
            authorizationUrl: "https://authorization.example/supabase",
            revision: 2
          };
        }
        return continuation.promise;
      }
    }),
    openAuthorizationUrl: async () => undefined
  });
  await service.ensureLoaded();

  const authorization = service.beginAuthorization("supabase");
  await waitFor(() => authorizationCalls === 2);
  await service.reload();

  assert.equal(
    service.dataStore.connectorsByKey.supabase?.authorization.state,
    "disconnected"
  );
  assert.equal(
    service.dataStore.pendingAuthorizationsByConnectorKey.supabase,
    true
  );

  continuation.resolve({
    connector: connected,
    operation: authorizationOperation,
    revision: 3
  });
  await authorization;

  assert.deepEqual(service.dataStore.pendingAuthorizationsByConnectorKey, {});
  service.dispose();
});

test("cancels a pending authorization attempt and stops waiting", async () => {
  const wait = deferred<void>();
  const pending = connector("supabase", 2);
  pending.authorization = { state: "pending" };
  let authorizationCalls = 0;
  let cancellationCalls = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [connector("supabase", 1)]),
      beginAuthorization: async () => {
        authorizationCalls += 1;
        return {
          connector: pending,
          operation: {
            ...operation("start_authorization", 2),
            connectorKey: "supabase",
            state: "completed" as const
          },
          authorizationUrl: "https://authorization.example/supabase",
          authorizationExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          revision: 2
        };
      },
      cancelAuthorization: async () => {
        cancellationCalls += 1;
      }
    }),
    openAuthorizationUrl: async () => undefined,
    waitForAuthorizationContinuation: () => wait.promise
  });
  await service.ensureLoaded();

  const authorization = service.beginAuthorization("supabase");
  await waitFor(() => authorizationCalls === 2);
  await service.cancelAuthorization("supabase");
  wait.resolve();

  await assert.rejects(
    authorization,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "connector_authorization_canceled"
  );
  assert.equal(cancellationCalls, 1);
  assert.deepEqual(service.dataStore.pendingAuthorizationsByConnectorKey, {});
  service.dispose();
});

test("keeps QR authorization in app state without opening its payload", async () => {
  const continueAuthorization = deferred<void>();
  const openedUrls: string[] = [];
  let step = 0;
  const initial = connector("wecom-cli", 1);
  initial.authorization = { state: "disconnected" };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [initial]),
      beginAuthorization: async () => {
        step += 1;
        if (step > 1) {
          await continueAuthorization.promise;
        }
        const next = connector("wecom-cli", step + 1);
        next.authorization = { state: step === 1 ? "pending" : "connected" };
        return {
          connector: next,
          operation: {
            ...operation("start_authorization", step + 1),
            connectorKey: "wecom-cli",
            state: "completed" as const
          },
          ...(step === 1
            ? {
                authorizationView: {
                  protocol: "tutti.connector.authorization.view.v1" as const,
                  viewId: "wecom-authorization-1",
                  view: {
                    type: "qr_code" as const,
                    source: {
                      type: "payload" as const,
                      value: "https://work.weixin.qq.com/ai/qc/c?s=opaque"
                    }
                  }
                }
              }
            : {}),
          revision: step + 1
        };
      }
    }),
    openAuthorizationUrl: async (url) => {
      openedUrls.push(url);
    }
  });
  await service.ensureLoaded();

  const authorization = service.beginAuthorization("wecom-cli");
  await waitFor(
    () =>
      service.dataStore.authorizationViewsByConnectorKey["wecom-cli"]?.view
        .type === "qr_code"
  );
  assert.deepEqual(openedUrls, []);

  continueAuthorization.resolve();
  await authorization;
  assert.deepEqual(service.dataStore.authorizationViewsByConnectorKey, {});
  service.dispose();
});

test("opens a device-code verification page once while keeping the code visible", async () => {
  const continueAuthorization = deferred<void>();
  const openedUrls: string[] = [];
  let step = 0;
  const initial = connector("github-cli", 1);
  initial.authorization = { state: "disconnected" };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [initial]),
      beginAuthorization: async () => {
        step += 1;
        if (step > 1) {
          await continueAuthorization.promise;
        }
        const next = connector("github-cli", step + 1);
        next.authorization = { state: step === 1 ? "pending" : "connected" };
        return {
          connector: next,
          operation: {
            ...operation("start_authorization", step + 1),
            connectorKey: "github-cli",
            state: "completed" as const
          },
          ...(step === 1
            ? {
                authorizationView: {
                  protocol: "tutti.connector.authorization.view.v1" as const,
                  viewId: "github-device-code-1",
                  view: {
                    type: "device_code" as const,
                    verificationUrl: "https://github.com/login/device",
                    userCode: "ABCD-EFGH"
                  }
                }
              }
            : {}),
          revision: step + 1
        };
      }
    }),
    openAuthorizationUrl: async (url) => {
      openedUrls.push(url);
    }
  });
  await service.ensureLoaded();

  const authorization = service.beginAuthorization("github-cli");
  await waitFor(
    () =>
      service.dataStore.authorizationViewsByConnectorKey["github-cli"]?.view
        .type === "device_code"
  );
  assert.deepEqual(openedUrls, ["https://github.com/login/device"]);
  assert.equal(
    service.dataStore.authorizationViewsByConnectorKey["github-cli"]?.view
      .type === "device_code"
      ? service.dataStore.authorizationViewsByConnectorKey["github-cli"]?.view
          .userCode
      : undefined,
    "ABCD-EFGH"
  );

  continueAuthorization.resolve();
  await authorization;
  assert.deepEqual(openedUrls, ["https://github.com/login/device"]);
  service.dispose();
});

test("fails closed when the host returns an invalid authorization view", async () => {
  const initial = connector("wecom-cli", 1);
  initial.authorization = { state: "disconnected" };
  const pending = connector("wecom-cli", 2);
  pending.authorization = { state: "pending" };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [initial]),
      beginAuthorization: async () => ({
        connector: pending,
        operation: {
          ...operation("start_authorization", 2),
          connectorKey: "wecom-cli",
          state: "completed" as const
        },
        authorizationView: {
          protocol: "tutti.connector.authorization.view.v1",
          viewId: "wecom-authorization-1",
          view: {
            type: "qr_code",
            source: { type: "payload", value: "" }
          }
        },
        revision: 2
      })
    })
  });
  await service.ensureLoaded();

  await assert.rejects(
    service.beginAuthorization("wecom-cli"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "connector_authorization_view_invalid"
  );
  assert.deepEqual(service.dataStore.authorizationViewsByConnectorKey, {});
  service.dispose();
});

test("expires a pending authorization attempt at its overall deadline", async () => {
  const pending = connector("supabase", 2);
  pending.authorization = { state: "pending" };
  let cancellationCalls = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [connector("supabase", 1)]),
      beginAuthorization: async () => ({
        connector: pending,
        operation: {
          ...operation("start_authorization", 2),
          connectorKey: "supabase",
          state: "completed" as const
        },
        authorizationUrl: "https://authorization.example/supabase",
        authorizationExpiresAt: new Date(Date.now() - 1).toISOString(),
        revision: 2
      }),
      cancelAuthorization: async () => {
        cancellationCalls += 1;
      }
    }),
    openAuthorizationUrl: async () => undefined
  });
  await service.ensureLoaded();

  await assert.rejects(
    service.beginAuthorization("supabase"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "connector_authorization_timeout"
  );
  assert.equal(cancellationCalls, 1);
  assert.deepEqual(service.dataStore.pendingAuthorizationsByConnectorKey, {});
  service.dispose();
});

test("waits for terminal authorization reconciliation before clearing loading", async () => {
  const terminalConnector = deferred<Connector>();
  const reconciliationStarted = deferred<void>();
  let authorizationCalls = 0;
  const initial = connector("notion", 1);
  initial.authorization = { state: "disconnected" };
  const pending = connector("notion", 2);
  pending.authorization = { state: "pending" };
  const connected = connector("notion", 3);
  connected.authorization = { state: "connected" };
  const acceptedOperation = {
    ...operation("start_authorization", 2),
    connectorKey: "notion",
    operationId: "notion-authorization",
    stage: "accepted" as const
  };
  const completedOperation = {
    ...acceptedOperation,
    state: "completed" as const,
    stage: "completed" as const,
    updatedAt: "2026-08-03T00:00:01Z"
  };
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => snapshot(1, [initial]),
      beginAuthorization: async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 1) {
          return {
            connector: pending,
            operation: acceptedOperation,
            authorizationUrl: "https://authorization.example/notion",
            revision: 2
          };
        }
        await reconciliationStarted.promise;
        return {
          connector: connected,
          operation: acceptedOperation,
          revision: 3
        };
      },
      getOperation: async () => completedOperation,
      getConnector: async () => {
        reconciliationStarted.resolve();
        return terminalConnector.promise;
      }
    }),
    openAuthorizationUrl: async () => undefined
  });
  await service.ensureLoaded();

  let settled = false;
  const authorization = service.beginAuthorization("notion").finally(() => {
    settled = true;
  });
  await waitFor(
    () =>
      service.dataStore.connectorsByKey.notion?.authorization.state ===
      "connected"
  );

  assert.equal(settled, false);
  assert.equal(
    service.dataStore.operationsByConnectorKey.notion?.stage,
    "completed"
  );

  terminalConnector.resolve(connected);
  await authorization;

  assert.equal(
    service.dataStore.operationsByConnectorKey.notion?.stage,
    "completed"
  );
  assert.deepEqual(service.dataStore.authorizingConnectorKeys, {});
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
    stage: "installing",
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

test("reloads one complete snapshot when the durable event cursor has a gap", async () => {
  const events = new TestEventSource();
  let snapshotCalls = 0;
  let connectorCalls = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        snapshotCalls += 1;
        return {
          ...snapshot(snapshotCalls >= 3 ? 7 : 5, [
            connector("github", snapshotCalls >= 3 ? 7 : 5)
          ]),
          eventCursor: snapshotCalls >= 3 ? 7 : 5
        };
      },
      getConnector: async () => {
        connectorCalls += 1;
        return connector("github", 7);
      }
    }),
    events
  });

  await service.ensureLoaded();
  service.start();
  await waitFor(() => snapshotCalls === 2);
  events.emit({
    type: "connector.market.changed",
    connectorKey: "github",
    revision: 7,
    cursor: 7
  });
  await waitFor(() => snapshotCalls === 3);

  assert.equal(connectorCalls, 0);
  assert.equal(service.dataStore.snapshotRevision, 7);
  assert.equal(service.dataStore.lastEventCursor, 7);
  service.dispose();
});

test("keeps cross-connector event loads when a newer global revision finishes first", async () => {
  const events = new TestEventSource();
  const alpha = deferred<Connector>();
  const beta = deferred<Connector>();
  let snapshotCalls = 0;
  const service = new ConnectorMarketService({
    backend: backendWith({
      getSnapshot: async () => {
        snapshotCalls += 1;
        return snapshot(1, [connector("alpha", 1), connector("beta", 1)]);
      },
      getConnector: async ({ connectorKey }) =>
        connectorKey === "alpha" ? alpha.promise : beta.promise
    }),
    events
  });
  await service.ensureLoaded();
  service.start();
  await waitFor(() => snapshotCalls === 2);

  events.emit({
    type: "connector.market.changed",
    connectorKey: "beta",
    revision: 2
  });
  events.emit({
    type: "connector.market.changed",
    connectorKey: "alpha",
    revision: 3
  });
  alpha.resolve(connector("alpha", 3));
  await waitFor(() => service.dataStore.connectorsByKey.alpha?.revision === 3);
  beta.resolve(connector("beta", 2));
  await waitFor(() => service.dataStore.connectorsByKey.beta?.revision === 2);

  assert.equal(service.dataStore.revision, 3);
  assert.equal(service.dataStore.connectorsByKey.alpha?.revision, 3);
  assert.equal(service.dataStore.connectorsByKey.beta?.revision, 2);
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
