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
} from "@tutti-os/workspace-app-center";
import {
  WorkspaceAppCenterService,
  type WorkspaceAppCenterServiceDependencies
} from "./workspaceAppCenterService.ts";
import { WorkspaceAppSurfaceHost } from "./workspaceAppSurfaceHost.ts";
import type { WorkspaceAppSurfacePresenter } from "../workspaceAppSurfaceHost.interface.ts";
import type {
  DesktopWorkspaceAppCenterLocalFileGateway,
  WorkspaceAppLike
} from "./adapters/desktopWorkspaceAppCenterGateway.ts";

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
              launchUrl: "http://127.0.0.1:3000"
            })
          ]
        }),
      launchWorkspaceApp: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: true,
              runtimeStatus: "running",
              stateRevision: 2,
              source: "builtin",
              launchUrl: "http://127.0.0.1:3000"
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    reporterNow: () => 1749124800000,
    reporterService: createReporterService(reporterCalls),
    surfaceHost: createSurfaceHost({
      presentPrepared(input) {
        const { attempt: _attempt, ...launch } = input;
        launchCalls.push(launch);
        return true;
      }
    })
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

test("WorkspaceAppCenterService delegates workspace app view open checks", () => {
  const checkedInputs: Array<{ appId: string; workspaceId: string }> = [];
  const surfaceHost = new WorkspaceAppSurfaceHost();
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway(),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    surfaceHost
  });

  assert.equal(
    service.isWorkspaceAppViewOpen({
      appId: "app-1",
      workspaceId: "workspace-1"
    }),
    false
  );

  surfaceHost.registerPresenter({
    beginOpen() {},
    close() {},
    isOpen(input) {
      checkedInputs.push(input);
      return input.appId === "app-1" && input.workspaceId === "workspace-1";
    },
    presentPrepared: () => false,
    rollbackOpen() {}
  });

  assert.equal(
    service.isWorkspaceAppViewOpen({
      appId: "app-1",
      workspaceId: "workspace-1"
    }),
    true
  );
  assert.equal(
    service.isWorkspaceAppViewOpen({
      appId: "app-2",
      workspaceId: "workspace-1"
    }),
    false
  );
  assert.deepEqual(checkedInputs, [
    {
      appId: "app-1",
      workspaceId: "workspace-1"
    },
    {
      appId: "app-2",
      workspaceId: "workspace-1"
    }
  ]);
});

test("WorkspaceAppCenterService rolls back shell presentation when launch preparation fails", async () => {
  const calls: string[] = [];
  const surfaceHost = createSurfaceHost({
    beginOpen({ appId }) {
      calls.push(`begin:${appId}`);
    },
    rollbackOpen({ appId }) {
      calls.push(`rollback:${appId}`);
    }
  });
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      listWorkspaceApps: async () => createSnapshot({ apps: [] })
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    surfaceHost
  });

  await service.refresh("workspace-1");
  assert.equal(
    await service.openApp({ appId: "missing", workspaceId: "workspace-1" }),
    false
  );
  assert.deepEqual(calls, ["begin:missing", "rollback:missing"]);
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

test("WorkspaceAppCenterService records low-volume diagnostics for running app update handoff", async () => {
  const diagnostics: DesktopRendererDiagnosticPayload[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      installWorkspaceApp: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              availableVersion: null,
              installed: true,
              launchUrl: "http://127.0.0.1:51234/",
              runtimeStatus: "running",
              source: "builtin",
              stateRevision: 4,
              updateAvailable: false,
              version: "1.1.0"
            })
          ]
        }),
      listWorkspaceApps: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              availableVersion: "1.1.0",
              installed: true,
              launchUrl: "http://127.0.0.1:50405/",
              runtimeStatus: "running",
              source: "builtin",
              stateRevision: 3,
              updateAvailable: true,
              version: "1.0.0"
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

  await service.refresh("workspace-1");
  await service.updateApp({
    appId: "app-1",
    trigger: "primary_action",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(
    diagnostics.map((entry) => {
      const details = entry.details ?? {};
      return {
        event: entry.event,
        launchUrlOrigin: details.launchUrlOrigin,
        level: entry.level,
        phase: details.phase,
        runtimeStatus: details.runtimeStatus,
        version: details.version
      };
    }),
    [
      {
        event: "workspace_app_center_update_handoff",
        launchUrlOrigin: "http://127.0.0.1:50405",
        level: "debug",
        phase: "started",
        runtimeStatus: "running",
        version: "1.0.0"
      },
      {
        event: "workspace_app_center_update_handoff",
        launchUrlOrigin: "http://127.0.0.1:51234",
        level: "debug",
        phase: "completed",
        runtimeStatus: "running",
        version: "1.1.0"
      }
    ]
  );
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
              launchUrl: "http://127.0.0.1:3000"
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

test("WorkspaceAppCenterService opens external URLs through host files", async () => {
  const openedUrls: string[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway(),
    hostFilesApi: createHostFilesApi({
      openExternal: async (url) => {
        openedUrls.push(url);
      }
    }),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  await service.openExternalUrl(" https://github.com/tutti-os/tutti ");
  await service.openExternalUrl("   ");

  assert.deepEqual(openedUrls, ["https://github.com/tutti-os/tutti"]);
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

test("WorkspaceAppCenterService opens local-dev package folders from localPackageDir", async () => {
  const openedFolders: OpenWorkspaceAppFolderInput[] = [];
  const revealedPaths: string[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      listWorkspaceApps: async () =>
        createSnapshot({
          apps: [
            createApp({
              appId: "local-dev",
              installed: true,
              localPackageDir: "/Users/example/project/.tutti/dev-app",
              source: "local-dev",
              version: "0.1.0"
            })
          ]
        })
    }),
    hostFilesApi: createHostFilesApi({
      revealInFolder: async (path) => {
        revealedPaths.push(path);
      }
    }),
    hostWorkspaceApi: createHostWorkspaceApi({
      openWorkspaceAppFolder: async (input) => {
        openedFolders.push(input);
      }
    })
  });

  await service.refresh("workspace-1");
  await service.openAppPackageFolder({
    appId: "local-dev",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(openedFolders, []);
  assert.deepEqual(revealedPaths, ["/Users/example/project/.tutti/dev-app"]);
});

test("WorkspaceAppCenterService loads selected local app directory", async () => {
  const calls: Array<{
    sourceDir: string;
    workspaceId: string;
    restartRunning?: boolean;
  }> = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      loadLocalWorkspaceApp: async (workspaceId, input) => {
        calls.push({
          sourceDir: input.sourceDir,
          restartRunning: input.restartRunning,
          workspaceId
        });
        return createSnapshot({
          apps: [
            createApp({
              appId: "local-dev",
              installed: true,
              localPackageDir: "/Users/example/project/.tutti/dev-app",
              source: "local-dev"
            })
          ]
        });
      }
    }),
    hostFilesApi: createHostFilesApi({
      selectDirectory: async () => "/Users/example/project"
    }),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  await service.loadLocalApp({ workspaceId: "workspace-1" });

  assert.deepEqual(calls, [
    {
      restartRunning: true,
      sourceDir: "/Users/example/project",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(service.store.apps[0]?.source, "local-dev");
  assert.equal(
    service.store.apps[0]?.localPackageDir,
    "/Users/example/project/.tutti/dev-app"
  );
});

test("WorkspaceAppCenterService returns a repair request for invalid local app directories", async () => {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      loadLocalWorkspaceApp: async () => {
        throw {
          error: {
            code: "invalid_request",
            reason: "malformed_request"
          }
        };
      }
    }),
    hostFilesApi: createHostFilesApi({
      selectDirectory: async () => "/Users/example/project"
    }),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  const request = await service.loadLocalApp({ workspaceId: "workspace-1" });

  assert.deepEqual(request, {
    projectDir: "/Users/example/project",
    sourceDir: "/Users/example/project"
  });
  assert.equal(service.store.error, null);
});

test("WorkspaceAppCenterService resolves local dev app folders back to the project root for repairs", async () => {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      loadLocalWorkspaceApp: async () => {
        throw {
          error: {
            code: "invalid_request",
            reason: "malformed_request"
          }
        };
      }
    }),
    hostFilesApi: createHostFilesApi({
      selectDirectory: async () => "/Users/example/project/.tutti/dev-app"
    }),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  const request = await service.loadLocalApp({ workspaceId: "workspace-1" });

  assert.deepEqual(request, {
    projectDir: "/Users/example/project",
    sourceDir: "/Users/example/project/.tutti/dev-app"
  });
});

test("WorkspaceAppCenterService keeps non-local load failures on the existing error path", async () => {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      loadLocalWorkspaceApp: async () => {
        throw {
          error: {
            code: "service_unavailable",
            reason: "daemon_unavailable"
          }
        };
      }
    }),
    hostFilesApi: createHostFilesApi({
      selectDirectory: async () => "/Users/example/project"
    }),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  const request = await service.loadLocalApp({ workspaceId: "workspace-1" });

  assert.equal(request, null);
  assert.equal(typeof service.store.error, "string");
});

test("WorkspaceAppCenterService reloads local app packages", async () => {
  const calls: Array<{
    appId: string;
    restartRunning?: boolean;
    workspaceId: string;
  }> = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      reloadLocalWorkspaceApp: async (workspaceId, appId, input) => {
        calls.push({
          appId,
          restartRunning: input?.restartRunning,
          workspaceId
        });
        return createSnapshot({
          apps: [
            createApp({
              appId,
              installed: true,
              localPackageDir: "/Users/example/project/.tutti/dev-app",
              source: "local-dev",
              stateRevision: 2
            })
          ]
        });
      }
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  await service.reloadLocalApp({
    appId: "local-dev",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(calls, [
    {
      appId: "local-dev",
      restartRunning: true,
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(service.store.apps[0]?.stateRevision, 2);
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
  const createFactoryJobInputs: Array<{
    agentTargetId: string;
    clientSubmitId: string;
    displayName: string;
    model?: string;
    permissionModeId?: string;
    prompt: string;
    reasoningEffort?: string;
  }> = [];
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
        createFactoryJobInputs.push(input);
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
    agentTargetId: "local:codex",
    displayName: "Dashboard App",
    model: "gpt-5",
    permissionModeId: "auto",
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

  const createFactoryJobInput = createFactoryJobInputs[0];
  assert.ok(createFactoryJobInput);
  assert.match(
    createFactoryJobInput.clientSubmitId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  assert.deepEqual(createFactoryJobInput, {
    agentTargetId: "local:codex",
    clientSubmitId: createFactoryJobInput.clientSubmitId,
    displayName: "Dashboard App",
    model: "gpt-5",
    permissionModeId: "auto",
    prompt: "build a dashboard",
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
      async getWorkspaceAppFactoryAgentTargetComposerOptions(
        workspaceId,
        agentTargetId
      ) {
        assert.equal(workspaceId, "workspace-1");
        assert.equal(agentTargetId, "local:codex");
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
          provider: "codex",
          reasoningConfig: {
            configurable: true,
            currentValue: "high",
            options: [
              { id: "medium", label: "Medium", value: "medium" },
              { id: "high", label: "High", value: "high" }
            ]
          },
          runtimeContext: {},
          skills: [],
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
        };
      }
    })
  });

  const configuration = await service.getFactoryProviderConfiguration({
    agentTargetId: "local:codex",
    provider: "codex",
    workspaceId: "workspace-1"
  });

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
      async getWorkspaceAppFactoryAgentTargetComposerOptions(
        _workspaceId,
        _agentTargetId
      ) {
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
          provider: "codex",
          reasoningConfig: {
            configurable: false,
            options: []
          },
          runtimeContext: {},
          skills: [],
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
        };
      }
    })
  });

  const configuration = await service.getFactoryProviderConfiguration({
    agentTargetId: "local:codex",
    provider: "codex",
    workspaceId: "workspace-1"
  });

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

test("WorkspaceAppCenterService passes workspace id and prefers live composer model options", async () => {
  const composerOptionsCalls: unknown[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway(),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    tuttidClient: createTuttidClient({
      async getWorkspaceAppFactoryAgentTargetComposerOptions(
        workspaceId,
        agentTargetId,
        request
      ) {
        composerOptionsCalls.push({ agentTargetId, request, workspaceId });
        return {
          effectiveSettings: {
            model: "sonnet",
            reasoningEffort: "high"
          },
          modelConfig: {
            configurable: true,
            currentValue: "default",
            options: [
              { id: "default", label: "Default", value: "default" },
              { id: "sonnet", label: "Sonnet", value: "sonnet" },
              { id: "haiku", label: "Haiku", value: "haiku" }
            ]
          },
          permissionConfig: {
            configurable: true,
            defaultValue: "default",
            modes: [
              {
                id: "default",
                label: "Default",
                semantic: "ask-before-write"
              }
            ]
          },
          provider: "claude-code",
          reasoningConfig: {
            configurable: true,
            currentValue: "high",
            options: [{ id: "high", label: "High", value: "high" }]
          },
          runtimeContext: {
            configOptions: [
              {
                currentValue: "sonnet",
                id: "model",
                options: [
                  { name: "Legacy Default", value: "default" },
                  { name: "Legacy Sonnet", value: "sonnet" }
                ]
              }
            ]
          },
          skills: [],
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
        };
      }
    })
  });

  const configuration = await service.getFactoryProviderConfiguration({
    agentTargetId: "local:claude-code",
    provider: "claude-code",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(composerOptionsCalls, [
    {
      agentTargetId: "local:claude-code",
      request: undefined,
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(configuration.modelOptions, [
    { label: "Default", value: "default" },
    { label: "Sonnet", value: "sonnet" },
    { label: "Haiku", value: "haiku" }
  ]);
  assert.equal(configuration.defaultModel, "sonnet");
});

test("WorkspaceAppCenterService reveals exported app archives", async () => {
  const exportInputs: Array<{ destinationPath: string; version: string }> = [];
  const revealedPaths: string[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      async listWorkspaceApps() {
        return createSnapshot({
          apps: [createApp({ appId: "exportable", version: "0.2.0" })]
        });
      },
      async exportWorkspaceApp(_workspaceId, appId, input) {
        assert.ok(input.version);
        exportInputs.push({
          destinationPath: input.destinationPath,
          version: input.version
        });
        return {
          appId,
          archivePath: input.destinationPath,
          artifactSha256: "sha",
          artifactSizeBytes: 1,
          version: input.version,
          workspaceId: "workspace-1"
        };
      }
    }),
    hostFilesApi: createHostFilesApi({
      async revealInFolder(path) {
        revealedPaths.push(path);
      },
      async selectAppArchiveExportPath(input) {
        assert.equal(input.defaultPath, "App_One_0.2.0.zip");
        return "/tmp/exportable.zip";
      }
    }),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  await service.refresh("workspace-1");
  await service.exportApp({ appId: "exportable", workspaceId: "workspace-1" });

  assert.deepEqual(exportInputs, [
    { destinationPath: "/tmp/exportable.zip", version: "0.2.0" }
  ]);
  assert.deepEqual(revealedPaths, ["/tmp/exportable.zip"]);
});

test("WorkspaceAppCenterService translates structured import and delete failures", async () => {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      async deleteWorkspaceApp() {
        throw Object.assign(new Error("cannot delete builtin app"), {
          code: "invalid_request",
          reason: "workspace_app_delete_forbidden"
        });
      },
      async importWorkspaceApp() {
        throw Object.assign(new Error("package exists"), {
          code: "invalid_request",
          reason: "workspace_app_package_exists"
        });
      },
      async listWorkspaceApps() {
        return createSnapshot({ apps: [createApp()] });
      }
    }),
    hostFilesApi: createHostFilesApi({
      selectAppArchive: async () => "/tmp/imported.zip"
    }),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  await service.importApp({ workspaceId: "workspace-1" });
  assert.equal(service.store.error, "This app version already exists.");

  await service.refresh("workspace-1");
  await service.deleteApp({ appId: "app-1", workspaceId: "workspace-1" });
  assert.equal(service.store.apps.length, 1);
  assert.equal(service.store.error, "That request could not be completed.");
});

test("WorkspaceAppCenterService refreshes after event stream reconnect", async () => {
  const eventStream = createReconnectableEventStreamClient();
  let listCalls = 0;
  const service = new WorkspaceAppCenterService({
    eventStreamClient: eventStream.client,
    gateway: createGateway({
      async listWorkspaceApps() {
        listCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              runtimeStatus: listCalls > 1 ? "running" : "idle",
              stateRevision: listCalls
            })
          ]
        });
      }
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi()
  });

  const dispose = service.startWorkspacePolling("workspace-1");
  await waitFor(() => listCalls === 1);
  eventStream.emitConnected();
  await waitFor(() => service.store.apps[0]?.runtimeStatus === "running");

  assert.equal(listCalls, 2);
  assert.equal(service.store.apps[0]?.runtimeStatus, "running");
  dispose();
});

test("WorkspaceAppCenterService closes app surfaces on uninstall and before restart", async () => {
  const calls: string[] = [];
  const runningApp = createApp({
    launchUrl: "http://127.0.0.1:3000",
    runtimeStatus: "running"
  });
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      async installWorkspaceApp(_workspaceId, _appId, input) {
        calls.push(`install:${String(input?.restartRunning)}`);
        return createSnapshot({
          apps: [createApp({ ...runningApp, stateRevision: 3 })]
        });
      },
      async listWorkspaceApps() {
        return createSnapshot({
          apps: [
            createApp({
              ...runningApp,
              runtimeStatus: "installed_pending_restart",
              stateRevision: 2
            })
          ]
        });
      },
      async uninstallWorkspaceApp() {
        return createSnapshot({
          apps: [
            createApp({
              installed: false,
              launchUrl: null,
              runtimeStatus: "idle",
              stateRevision: 4
            })
          ]
        });
      }
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    surfaceHost: createSurfaceHost({
      close({ appId }) {
        calls.push(`close:${appId}`);
      },
      presentPrepared({ appId }) {
        calls.push(`present:${appId}`);
        return true;
      }
    })
  });

  await service.refresh("workspace-1");
  assert.equal(
    await service.restartAndOpenApp({
      appId: "app-1",
      workspaceId: "workspace-1"
    }),
    true
  );
  assert.deepEqual(calls, ["close:app-1", "install:true", "present:app-1"]);

  calls.length = 0;
  await service.uninstallApp({ appId: "app-1", workspaceId: "workspace-1" });
  assert.deepEqual(calls, ["close:app-1"]);
});

test("WorkspaceAppCenterService translates failed-runtime launch errors with operation details", async () => {
  const diagnostics: DesktopRendererDiagnosticPayload[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createEventStreamClient(),
    gateway: createGateway({
      async launchWorkspaceApp() {
        throw {
          error: {
            code: "invalid_request",
            developerMessage:
              "failed workspace apps must be retried before launch",
            reason: "malformed_request"
          }
        };
      },
      async listWorkspaceApps() {
        return createSnapshot({ apps: [createApp()] });
      }
    }),
    hostFilesApi: createHostFilesApi(),
    hostWorkspaceApi: createHostWorkspaceApi(),
    runtimeApi: {
      async logRendererDiagnostic(payload) {
        diagnostics.push(payload);
      }
    }
  });

  await service.refresh("workspace-1");
  assert.equal(
    await service.openApp({ appId: "app-1", workspaceId: "workspace-1" }),
    false
  );
  assert.equal(
    service.store.error,
    "This app failed to start. Click Retry before opening it."
  );
  assert.deepEqual(diagnostics[0], {
    details: {
      appId: "app-1",
      developerMessage: "failed workspace apps must be retried before launch",
      errorCode: "invalid_request",
      params: {},
      operation: "workspace_app.prepare_launch",
      reason: "malformed_request",
      retryable: false,
      statusCode: 0,
      toastMessage: "This app failed to start. Click Retry before opening it.",
      uiAction: "open_app",
      workspaceId: "workspace-1"
    },
    event: "workspace_app_center_operation_failed",
    level: "warn",
    source: "workspace-app-center",
    workspaceId: "workspace-1"
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
    references: { listSupported: false },
    runtimeStatus: "idle",
    source: "generated",
    stateRevision: 1,
    launchUrl: null,
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
  overrides: Partial<
    WorkspaceAppCenterGateway & DesktopWorkspaceAppCenterLocalFileGateway
  > = {}
): WorkspaceAppCenterGateway & DesktopWorkspaceAppCenterLocalFileGateway {
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
    async loadLocalWorkspaceApp() {
      return createSnapshot();
    },
    async launchWorkspaceApp() {
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
    async reloadLocalWorkspaceApp() {
      return createSnapshot();
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
    openExternal: async () => {},
    revealInFolder: async () => {},
    selectAppArchive: async () => null,
    selectAppArchiveExportPath: async () => null,
    selectDirectory: async () => null,
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

function createReconnectableEventStreamClient(): {
  client: WorkspaceAppCenterServiceDependencies["eventStreamClient"];
  emitConnected: () => void;
} {
  const listeners = new Set<(state: "connected") => void>();
  return {
    client: {
      ...createEventStreamClient(),
      subscribeConnectionState(listener: (state: "connected") => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    } as WorkspaceAppCenterServiceDependencies["eventStreamClient"],
    emitConnected() {
      for (const listener of listeners) {
        listener("connected");
      }
    }
  };
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

function createSurfaceHost(
  overrides: Partial<WorkspaceAppSurfacePresenter>
): WorkspaceAppSurfaceHost {
  const host = new WorkspaceAppSurfaceHost();
  host.registerPresenter({
    beginOpen() {},
    close() {},
    isOpen: () => false,
    presentPrepared: () => false,
    rollbackOpen() {},
    ...overrides
  });
  return host;
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
  overrides: Partial<
    Pick<TuttidClient, "getWorkspaceAppFactoryAgentTargetComposerOptions">
  > = {}
): Pick<TuttidClient, "getWorkspaceAppFactoryAgentTargetComposerOptions"> {
  return {
    async getWorkspaceAppFactoryAgentTargetComposerOptions(
      _workspaceId,
      agentTargetId
    ) {
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
        provider:
          agentTargetId === "local:claude-code" ? "claude-code" : "codex",
        reasoningConfig: {
          configurable: false,
          options: []
        },
        runtimeContext: {},
        skills: [],
        behavior: {
          collapseModelOptionsToLatest: false,
          modelOptionsAuthoritative: false,
          refreshModelOptionsAfterSettings: false,
          prewarmDraftSession: false,
          planModeExclusiveWithPermissionMode: false
        },
        capabilityCatalog: [],
        reasoningOptionsByModel: {},
        commands: []
      };
    },
    ...overrides
  };
}
