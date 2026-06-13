import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopRendererDiagnosticPayload } from "@shared/contracts/ipc";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterGateway,
  WorkspaceAppCenterSnapshot,
  WorkspaceAppFactoryJob,
  WorkspaceAppFactorySnapshot
} from "../workspaceAppCenterTypes.ts";
import {
  WorkspaceAppCenterService,
  type WorkspaceAppCenterServiceDependencies
} from "./workspaceAppCenterService.ts";
import type { WorkspaceAppLike } from "./adapters/desktopWorkspaceAppCenterGateway.ts";

type OpenWorkspaceAppFolderInput = Parameters<
  WorkspaceAppCenterServiceDependencies["hostWorkspaceApi"]["openWorkspaceAppFolder"]
>[0];

test("WorkspaceAppCenterService tracks app install and forwards app open status", async () => {
  const launchCalls: Array<{
    appId: string;
    prepared: boolean;
    prevStatus?: WorkspaceAppCenterApp["runtimeStatus"];
    workspaceId?: string;
  }> = [];
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      installWorkspaceApp: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: true,
              stateRevision: 3,
              source: "builtin"
            })
          ]
        }),
      listWorkspaceApps: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: true,
              runtimeStatus: "idle",
              source: "builtin",
              url: "http://127.0.0.1:3000"
            })
          ]
        }),
      retryWorkspaceApp: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: true,
              runtimeStatus: "running",
              stateRevision: 2,
              source: "builtin",
              url: "http://127.0.0.1:3000"
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls)
  });
  service.setWorkspaceAppLauncher(async (input) => {
    launchCalls.push(input);
  });

  await service.refresh("workspace-1");
  await service.openApp({ appId: "app-1", workspaceId: "workspace-1" });
  await service.installApp({ appId: "app-1", workspaceId: "workspace-1" });

  assert.deepEqual(launchCalls, [
    {
      appId: "app-1",
      prepared: true,
      prevStatus: "idle",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "app_center.app_installed",
        params: {
          app_id: "app-1",
          app_source: "builtin"
        }
      }
    ]
  ]);
});

test("WorkspaceAppCenterService tracks app install when the success snapshot omits the app", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  let listCalls = 0;
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      installWorkspaceApp: async () => createSnapshot({ apps: [] }),
      listWorkspaceApps: async () => {
        listCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: listCalls > 1,
              source: "builtin"
            })
          ]
        });
      }
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls)
  });

  await service.refresh("workspace-1");
  await service.installApp({ appId: "app-1", workspaceId: "workspace-1" });

  await waitFor(() => service.store.apps[0]?.installed === true);
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "app_center.app_installed",
        params: {
          app_id: "app-1",
          app_source: "builtin"
        }
      }
    ]
  ]);
});

test("WorkspaceAppCenterService merges catalog refresh fields without regressing runtime state", async () => {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      listWorkspaceApps: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              availableVersion: null,
              runtimeStatus: "running",
              source: "builtin",
              stateRevision: 3,
              updateAvailable: false,
              version: "1.0.0"
            })
          ]
        }),
      refreshWorkspaceAppCatalog: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              availableVersion: "1.1.0",
              runtimeStatus: "idle",
              source: "builtin",
              stateRevision: 3,
              updateAvailable: true,
              version: "1.0.0"
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  await service.refresh("workspace-1");
  await service.refreshCatalog("workspace-1");

  assert.equal(service.store.apps[0]?.availableVersion, "1.1.0");
  assert.equal(service.store.apps[0]?.updateAvailable, true);
  assert.equal(service.store.apps[0]?.runtimeStatus, "running");
});

test("WorkspaceAppCenterService keeps factory jobs when catalog refresh supersedes app refresh", async () => {
  const diagnostics: DesktopRendererDiagnosticPayload[] = [];
  const appRefresh = createDeferred<WorkspaceAppCenterSnapshot>();
  const factoryRefresh = createDeferred<WorkspaceAppFactorySnapshot>();
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      listWorkspaceAppFactoryJobs: async () => factoryRefresh.promise,
      listWorkspaceApps: async () => appRefresh.promise,
      refreshWorkspaceAppCatalog: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-from-catalog",
              name: "Catalog App",
              stateRevision: 2
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    runtimeApi: {
      async logRendererDiagnostic(payload) {
        diagnostics.push(payload);
      }
    }
  });

  const refreshPromise = service.refresh("workspace-1");
  await service.refreshCatalog("workspace-1");

  appRefresh.resolve(
    createSnapshot({
      apps: [
        createApp({
          appId: "app-from-refresh",
          name: "Refresh App",
          stateRevision: 1
        })
      ]
    })
  );
  factoryRefresh.resolve(
    createFactorySnapshot({
      jobs: [
        createFactoryJob({
          jobId: "job-visible",
          status: "generating"
        })
      ]
    })
  );
  await refreshPromise;

  assert.equal(service.store.apps[0]?.appId, "app-from-catalog");
  assert.equal(service.store.factoryJobs[0]?.jobId, "job-visible");
  assert.equal(service.store.factoryJobs[0]?.status, "generating");

  const discardDiagnostic = diagnostics.find(
    (diagnostic) =>
      diagnostic.event === "workspace_app_center_refresh_snapshot_discarded"
  );
  assert.deepEqual(discardDiagnostic?.details, {
    currentSequence: 2,
    itemCount: 1,
    operation: "app_center.refresh",
    sequence: 1,
    snapshotKind: "apps"
  });
  const factoryDiagnostic = diagnostics.find(
    (diagnostic) =>
      diagnostic.event === "workspace_app_center_factory_snapshot_applied"
  );
  assert.deepEqual(factoryDiagnostic?.details, {
    afterCount: 1,
    beforeCount: 0,
    jobs: [
      {
        jobId: "job-visible",
        status: "generating",
        updatedAtUnixMs: 1749124800000
      }
    ],
    truncated: false
  });
});

test("WorkspaceAppCenterService keeps update disabled while update install is pending", async () => {
  let installCalls = 0;
  let listCalls = 0;
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      installWorkspaceApp: async () => {
        installCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              availableVersion: "1.1.0",
              installed: true,
              runtimeStatus: "running",
              source: "builtin",
              stateRevision: 3,
              updateAvailable: true,
              version: "1.0.0"
            })
          ]
        });
      },
      listWorkspaceApps: async () => {
        listCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              availableVersion: listCalls > 1 ? null : "1.1.0",
              installed: true,
              runtimeStatus: listCalls > 1 ? "running" : "idle",
              source: "builtin",
              stateRevision: listCalls > 1 ? 4 : 3,
              updateAvailable: listCalls <= 1,
              version: listCalls > 1 ? "1.1.0" : "1.0.0"
            })
          ]
        });
      }
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  await service.refresh("workspace-1");
  const firstUpdate = service.updateApp({
    appId: "app-1",
    trigger: "primary_action",
    workspaceId: "workspace-1"
  });
  await waitFor(() => service.store.apps[0]?.runtimeStatus === "installing");
  await service.updateApp({
    appId: "app-1",
    trigger: "primary_action",
    workspaceId: "workspace-1"
  });

  assert.equal(installCalls, 1);
  assert.equal(service.store.apps[0]?.availableVersion, "1.1.0");
  assert.equal(service.store.apps[0]?.runtimeStatus, "installing");
  assert.equal(service.store.apps[0]?.updateAvailable, true);
  assert.equal(service.store.apps[0]?.version, "1.0.0");

  await firstUpdate;
  await service.refresh("workspace-1");

  assert.equal(installCalls, 1);
  assert.equal(service.store.apps[0]?.runtimeStatus, "running");
  assert.equal(service.store.apps[0]?.updateAvailable, false);
  assert.equal(service.store.apps[0]?.version, "1.1.0");
});

test("WorkspaceAppCenterService waits for async install completion before tracking app install", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  let listCalls = 0;
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      installWorkspaceApp: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: false,
              runtimeStatus: "idle",
              source: "builtin"
            })
          ]
        }),
      listWorkspaceApps: async () => {
        listCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: listCalls > 1,
              runtimeStatus: listCalls > 1 ? "running" : "idle",
              source: "builtin",
              stateRevision: listCalls > 1 ? 2 : 1
            })
          ]
        });
      }
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls)
  });

  await service.refresh("workspace-1");
  await service.installApp({ appId: "app-1", workspaceId: "workspace-1" });

  assert.deepEqual(reporterCalls, []);
  assert.equal(service.store.apps[0]?.installed, false);

  await waitFor(() => service.store.apps[0]?.installed === true);
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "app_center.app_installed",
        params: {
          app_id: "app-1",
          app_source: "builtin"
        }
      }
    ]
  ]);
});

test("WorkspaceAppCenterService tracks app install failure when async install fails", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  let listCalls = 0;
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      installWorkspaceApp: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: false,
              runtimeStatus: "idle",
              source: "builtin"
            })
          ]
        }),
      listWorkspaceApps: async () => {
        listCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              failureReason: listCalls > 1 ? "install script exited 1" : null,
              appId: "app-1",
              installed: false,
              lastError: listCalls > 1 ? "npm install failed" : null,
              runtimeStatus: listCalls > 1 ? "failed" : "idle",
              source: "builtin",
              stateRevision: listCalls > 1 ? 2 : 1
            })
          ]
        });
      }
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls)
  });

  await service.refresh("workspace-1");
  await service.installApp({ appId: "app-1", workspaceId: "workspace-1" });

  await waitFor(() => service.store.apps[0]?.runtimeStatus === "failed");
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "app_center.app_install_failed",
        params: {
          app_id: "app-1",
          app_source: "builtin",
          failure_reason: "install script exited 1"
        }
      }
    ]
  ]);
});

test("WorkspaceAppCenterService forwards running status when reopening a running app", async () => {
  const launchCalls: Array<{
    appId: string;
    prepared: boolean;
    prevStatus?: WorkspaceAppCenterApp["runtimeStatus"];
    workspaceId?: string;
  }> = [];
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      listWorkspaceApps: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: true,
              runtimeStatus: "running",
              source: "builtin",
              url: "http://127.0.0.1:3000"
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls)
  });
  service.setWorkspaceAppLauncher(async (input) => {
    launchCalls.push(input);
  });

  await service.refresh("workspace-1");
  await service.openApp({ appId: "app-1", workspaceId: "workspace-1" });

  assert.deepEqual(launchCalls, [
    {
      appId: "app-1",
      prepared: true,
      prevStatus: "running",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(reporterCalls, []);
});

test("WorkspaceAppCenterService ignores stale failed updates before tracking runtime failures", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const eventStream = createControllableEventStreamClient();
  const service = new WorkspaceAppCenterService({
    eventStreamClient: eventStream.client,
    gateway: createGateway({
      listWorkspaceApps: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: true,
              runtimeStatus: "running",
              source: "generated",
              stateRevision: 2,
              url: "http://127.0.0.1:3000"
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls)
  });

  await service.refresh("workspace-1");
  service.startWorkspacePolling("workspace-1");
  eventStream.publishWorkspaceAppUpdated(
    createProtocolApp({
      appId: "app-1",
      status: "failed",
      stateRevision: 1
    })
  );
  eventStream.publishWorkspaceAppUpdated(
    createProtocolApp({
      appId: "app-1",
      status: "failed",
      stateRevision: 1
    })
  );

  assert.equal(service.store.apps[0]?.runtimeStatus, "running");
  assert.deepEqual(reporterCalls, []);
});

test("WorkspaceAppCenterService tracks accepted runtime failure transitions once", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const eventStream = createControllableEventStreamClient();
  const service = new WorkspaceAppCenterService({
    eventStreamClient: eventStream.client,
    gateway: createGateway({
      listWorkspaceApps: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: true,
              runtimeStatus: "running",
              source: "generated",
              stateRevision: 2,
              url: "http://127.0.0.1:3000"
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls)
  });

  await service.refresh("workspace-1");
  service.startWorkspacePolling("workspace-1");
  eventStream.publishWorkspaceAppUpdated(
    createProtocolApp({
      appId: "app-1",
      failureReason: "process exited",
      status: "failed",
      stateRevision: 3
    })
  );
  eventStream.publishWorkspaceAppUpdated(
    createProtocolApp({
      appId: "app-1",
      failureReason: "process exited",
      status: "failed",
      stateRevision: 3
    })
  );

  assert.equal(service.store.apps[0]?.runtimeStatus, "failed");
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "error.app_runtime_failed",
        params: {
          app_id: "app-1",
          app_source: "generated",
          failure_reason: "process exited"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "app_center.app_stopped",
        params: {
          app_id: "app-1",
          app_source: "generated",
          run_duration_ms: null
        }
      }
    ]
  ]);
});

test("WorkspaceAppCenterService opens workspace and package app folders", async () => {
  const openedFolders: OpenWorkspaceAppFolderInput[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      listWorkspaceApps: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: true,
              version: "1.2.3"
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi({
      openWorkspaceAppFolder: async (input) => {
        openedFolders.push(input);
      }
    })
  });

  await service.refresh("workspace-1");
  await service.openAppFolder({ appId: "app-1", workspaceId: "workspace-1" });
  await service.openAppPackageFolder({
    appId: "app-1",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(openedFolders, [
    {
      appId: "app-1",
      folderKind: "workspace",
      workspaceId: "workspace-1"
    },
    {
      appId: "app-1",
      folderKind: "package",
      version: "1.2.3",
      workspaceId: "workspace-1"
    }
  ]);
});

test("WorkspaceAppCenterService does not open package folders for builtin apps", async () => {
  const openedFolders: OpenWorkspaceAppFolderInput[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      listWorkspaceApps: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: true,
              source: "builtin",
              version: "1.2.3"
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi({
      openWorkspaceAppFolder: async (input) => {
        openedFolders.push(input);
      }
    })
  });

  await service.refresh("workspace-1");
  await service.openAppPackageFolder({
    appId: "app-1",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(openedFolders, []);
});

test("WorkspaceAppCenterService consumes operation errors once", async () => {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      importWorkspaceApp: async () => {
        throw new Error("invalid package");
      }
    }),
    hostFilesApi: createHostFilesApi({
      selectAppArchive: async () => "/tmp/app.tuttiapp"
    }),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  await service.importApp({ workspaceId: "workspace-1" });

  const firstError = service.store.error;
  assert.equal(typeof firstError, "string");
  assert.equal(service.consumeError(), firstError);
  assert.equal(service.store.error, null);
  assert.equal(service.consumeError(), null);

  await service.importApp({ workspaceId: "workspace-1" });

  const secondError = service.store.error;
  assert.equal(typeof secondError, "string");
  assert.equal(service.consumeError(), secondError);
});

test("WorkspaceAppCenterService uses publish-specific workspace operation error copy", async () => {
  const diagnostics: unknown[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      publishWorkspaceAppFactoryJob: async () => {
        throw Object.assign(new Error("workspace operation failed"), {
          code: "workspace_operation_failed",
          developerMessage: "read AGENTS.md: no such file or directory",
          reason: "workspace_operation_failed"
        });
      }
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    runtimeApi: {
      async logRendererDiagnostic(input) {
        diagnostics.push(input);
      }
    }
  });

  await service.publishFactoryJob({
    jobId: "job-1",
    workspaceId: "workspace-1"
  });

  assert.equal(
    service.store.error,
    "The app draft did not pass its pre-publish check. Fix it from App Center before publishing."
  );
  assert.deepEqual(
    diagnostics.map(
      (entry) =>
        (entry as { details: { toastMessage: string } }).details.toastMessage
    ),
    [
      "The app draft did not pass its pre-publish check. Fix it from App Center before publishing."
    ]
  );
});

test("WorkspaceAppCenterService tracks import failure and catalog refresh result", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      importWorkspaceApp: async () => {
        throw Object.assign(new Error("invalid package"), {
          code: "invalid_package"
        });
      },
      refreshWorkspaceAppCatalog: async () =>
        createSnapshot({
          apps: [createApp({ appId: "app-1" })]
        })
    }),
    hostFilesApi: createHostFilesApi({
      selectAppArchive: async () => "/tmp/app.tuttiapp"
    }),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls)
  });

  await service.importApp({ workspaceId: "workspace-1" });
  await service.refreshCatalog("workspace-1");

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "app_center.catalog_refreshed",
        params: {
          app_count: 1,
          error_reason: null,
          success: true
        }
      }
    ]
  ]);
});

test("WorkspaceAppCenterService tracks factory job lifecycle events", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  let createFactoryJobInput: {
    displayName: string;
    model?: string;
    permissionModeId?: string;
    prompt: string;
    provider?: string;
    reasoningEffort?: string;
  } | null = null;
  const createdJob = createFactoryJob({
    jobId: "job-1",
    model: "gpt-5",
    provider: "codex",
    status: "generating"
  });
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      cancelWorkspaceAppFactoryJob: async () =>
        createFactorySnapshot({
          jobs: [createFactoryJob({ jobId: "job-1", status: "canceled" })]
        }),
      createWorkspaceAppFactoryJob: async (_workspaceId, input) => {
        createFactoryJobInput = input;
        return createFactorySnapshot({
          jobs: [createdJob]
        });
      },
      publishWorkspaceAppFactoryJob: async () => ({
        appSnapshot: createSnapshot({
          apps: [createApp({ appId: "app-1", source: "generated" })]
        }),
        factorySnapshot: createFactorySnapshot({
          jobs: [
            createFactoryJob({
              appId: "app-1",
              jobId: "job-1",
              status: "published"
            })
          ]
        })
      })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls)
  });

  await service.createFactoryJob({
    displayName: "Dashboard App",
    model: "gpt-5",
    permissionModeId: "auto",
    provider: "codex",
    prompt: "build a dashboard",
    reasoningEffort: "high",
    workspaceId: "workspace-1"
  });
  await service.cancelFactoryJob({
    jobId: "job-1",
    workspaceId: "workspace-1"
  });
  await service.publishFactoryJob({
    jobId: "job-1",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(createFactoryJobInput, {
    displayName: "Dashboard App",
    model: "gpt-5",
    permissionModeId: "auto",
    prompt: "build a dashboard",
    provider: "codex",
    reasoningEffort: "high"
  });
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "app_center.factory_job_created",
        params: {
          job_id: "job-1",
          model: "gpt-5",
          provider: "codex",
          reasoning_effort: null,
          status: "generating",
          workspace_id: "workspace-1"
        }
      }
    ]
  ]);
});

test("WorkspaceAppCenterService normalizes provider configuration", async () => {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway(),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider) {
        assert.equal(provider, "codex");
        return {
          effectiveSettings: {},
          modelConfig: {
            configurable: true,
            currentValue: "gpt-5",
            options: [
              {
                id: "gpt-5-mini",
                label: "GPT-5 Mini",
                value: "gpt-5-mini"
              }
            ]
          },
          permissionConfig: {
            configurable: true,
            defaultValue: "auto",
            modes: [
              {
                id: "read-only",
                label: "Ask for approval",
                semantic: "ask-before-write"
              },
              {
                id: "auto",
                label: "Approve for me",
                semantic: "auto"
              }
            ]
          },
          provider,
          reasoningConfig: {
            configurable: true,
            currentValue: "high",
            options: [
              { id: "medium", label: "Medium", value: "medium" },
              { id: "high", label: "High", value: "high" }
            ]
          },
          runtimeContext: {},
          skills: []
        };
      }
    })
  });

  const configuration = await service.getFactoryProviderConfiguration("codex");

  assert.deepEqual(configuration, {
    defaultModel: "gpt-5",
    defaultPermissionModeId: "auto",
    defaultReasoningEffort: "high",
    modelOptions: [
      { label: "GPT-5 Mini", value: "gpt-5-mini" },
      { label: "gpt-5", value: "gpt-5" }
    ],
    permissionModeOptions: [
      {
        label: "Ask for approval",
        semantic: "ask-before-write",
        value: "read-only"
      },
      { label: "Approve for me", semantic: "auto", value: "auto" }
    ],
    reasoningEffortOptions: [
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" }
    ]
  });
});

test("WorkspaceAppCenterService makes effective permission default visible", async () => {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway(),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider) {
        return {
          effectiveSettings: {
            permissionModeId: "full-access"
          },
          modelConfig: {
            configurable: false,
            options: []
          },
          permissionConfig: {
            configurable: true,
            modes: [{ id: "auto", label: "Approve for me", semantic: "auto" }]
          },
          provider,
          reasoningConfig: {
            configurable: false,
            options: []
          },
          runtimeContext: {},
          skills: []
        };
      }
    })
  });

  const configuration = await service.getFactoryProviderConfiguration("codex");

  assert.deepEqual(configuration, {
    defaultModel: null,
    defaultPermissionModeId: "full-access",
    defaultReasoningEffort: null,
    modelOptions: [],
    permissionModeOptions: [
      { label: "Approve for me", semantic: "auto", value: "auto" },
      { label: "full-access", value: "full-access" }
    ],
    reasoningEffortOptions: []
  });
});

function createApp(
  overrides: Partial<WorkspaceAppCenterApp> = {}
): WorkspaceAppCenterApp {
  return {
    appId: "app-1",
    createdAtUnixMs: 1749124600000,
    enabled: true,
    exportable: true,
    installed: true,
    minimizeBehavior: "keep-mounted",
    name: "App One",
    runtimeStatus: "idle",
    source: "generated",
    stateRevision: 1,
    url: null,
    version: "1.0.0",
    ...overrides
  };
}

function createProtocolApp(
  overrides: Partial<WorkspaceAppLike> = {}
): WorkspaceAppLike {
  return {
    appId: "app-1",
    createdAtUnixMs: 1749124600000,
    description: "App one description",
    displayName: "App One",
    enabled: true,
    exportable: true,
    installed: true,
    launchUrl: null,
    minimizeBehavior: "keep-mounted",
    source: "generated",
    stateRevision: 1,
    status: "idle",
    version: "1.0.0",
    ...overrides
  };
}

function createFactoryJob(
  overrides: Partial<WorkspaceAppFactoryJob> = {}
): WorkspaceAppFactoryJob {
  return {
    createdAtUnixMs: 1749124700000,
    displayName: "Dashboard App",
    jobId: "job-1",
    prompt: "build a dashboard",
    status: "queued",
    updatedAtUnixMs: 1749124800000,
    workspaceId: "workspace-1",
    ...overrides
  };
}

function createSnapshot(
  overrides: Partial<WorkspaceAppCenterSnapshot> = {}
): WorkspaceAppCenterSnapshot {
  return {
    apps: [],
    catalogStatus: "ready",
    ...overrides
  };
}

function createFactorySnapshot(
  overrides: Partial<WorkspaceAppFactorySnapshot> = {}
): WorkspaceAppFactorySnapshot {
  return {
    jobs: [],
    ...overrides
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createGateway(
  overrides: Partial<WorkspaceAppCenterGateway> = {}
): WorkspaceAppCenterGateway {
  return {
    async cancelWorkspaceAppFactoryJob() {
      return createFactorySnapshot();
    },
    async createWorkspaceAppFactoryJob() {
      return createFactorySnapshot();
    },
    async deleteWorkspaceApp() {
      return createSnapshot();
    },
    async deleteWorkspaceAppFactoryJob() {
      return createFactorySnapshot();
    },
    async exportWorkspaceApp() {
      return {
        appId: "app-1",
        archivePath: "/tmp/app.tuttiapp",
        artifactSha256: "sha",
        artifactSizeBytes: 1,
        version: "1.0.0",
        workspaceId: "workspace-1"
      };
    },
    async fixWorkspaceAppFactoryJob() {
      return createFactorySnapshot();
    },
    async prepareWorkspaceAppFactoryJobModification() {
      return createFactorySnapshot();
    },
    async importWorkspaceApp() {
      return createSnapshot();
    },
    async installWorkspaceApp() {
      return createSnapshot();
    },
    async listWorkspaceAppFactoryJobs() {
      return createFactorySnapshot();
    },
    async listWorkspaceApps() {
      return createSnapshot();
    },
    async publishWorkspaceAppFactoryJob() {
      return {
        appSnapshot: createSnapshot(),
        factorySnapshot: createFactorySnapshot()
      };
    },
    async refreshWorkspaceAppCatalog() {
      return createSnapshot();
    },
    async replaceWorkspaceAppIcon() {
      return createApp();
    },
    async retryWorkspaceApp() {
      return createSnapshot();
    },
    async retryWorkspaceAppFactoryJobValidation() {
      return createFactorySnapshot();
    },
    async rollbackWorkspaceApp() {
      return createSnapshot();
    },
    async startEnabledWorkspaceApps() {
      return createSnapshot();
    },
    async uninstallWorkspaceApp() {
      return createSnapshot();
    },
    ...overrides
  };
}

function createHostFilesApi(
  overrides: Partial<WorkspaceAppCenterServiceDependencies["hostFilesApi"]> = {}
): WorkspaceAppCenterServiceDependencies["hostFilesApi"] {
  return {
    revealInFolder: async () => {},
    selectAppArchive: async () => null,
    selectAppArchiveExportPath: async () => null,
    selectAppIconImage: async () => null,
    ...overrides
  };
}

function createHostWorkspaceApi(
  overrides: Partial<
    WorkspaceAppCenterServiceDependencies["hostWorkspaceApi"]
  > = {}
): WorkspaceAppCenterServiceDependencies["hostWorkspaceApi"] {
  return {
    openWorkspaceAppFolder: async () => {},
    ...overrides
  };
}

function createEventStreamClient(): WorkspaceAppCenterServiceDependencies["eventStreamClient"] {
  return {
    connect: async () => {},
    disconnect: async () => {},
    dispose: () => {},
    publish: async () => {},
    publishIntent: async () => {},
    subscribe: () => () => {},
    subscribeConnectionState: () => () => {}
  } as unknown as WorkspaceAppCenterServiceDependencies["eventStreamClient"];
}

function createControllableEventStreamClient(): {
  client: WorkspaceAppCenterServiceDependencies["eventStreamClient"];
  publishWorkspaceAppUpdated: (app: WorkspaceAppLike) => void;
} {
  const appUpdatedListeners: Array<
    (event: { payload: { app: WorkspaceAppLike } }) => void
  > = [];
  return {
    client: {
      connect: async () => {},
      disconnect: async () => {},
      dispose: () => {},
      publish: async () => {},
      publishIntent: async () => {},
      subscribe: (topic: string, listener: unknown) => {
        if (topic === "workspace.app.updated") {
          appUpdatedListeners.push(
            listener as (event: { payload: { app: WorkspaceAppLike } }) => void
          );
        }
        return () => {};
      },
      subscribeConnectionState: () => () => {}
    } as unknown as WorkspaceAppCenterServiceDependencies["eventStreamClient"],
    publishWorkspaceAppUpdated(app) {
      for (const listener of appUpdatedListeners) {
        listener({ payload: { app } });
      }
    }
  };
}

function createReporterService(calls: ReporterEventInput[][] = []) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

function createTuttidClient(
  overrides: Partial<Pick<TuttidClient, "getAgentProviderComposerOptions">> = {}
): Pick<TuttidClient, "getAgentProviderComposerOptions"> {
  return {
    async getAgentProviderComposerOptions(provider) {
      return {
        effectiveSettings: {},
        modelConfig: {
          configurable: false,
          options: []
        },
        permissionConfig: {
          configurable: true,
          modes: []
        },
        provider,
        reasoningConfig: {
          configurable: false,
          options: []
        },
        runtimeContext: {},
        skills: []
      };
    },
    ...overrides
  };
}
