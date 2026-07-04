import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttidEventStreamClient,
  WorkspaceApp,
  WorkspaceAppListResponse
} from "@tutti-os/client-tuttid-ts";
import type {
  WorkspaceAppCenterGateway,
  WorkspaceAppFactoryJob,
  WorkspaceAppCenterRuntimeStatus
} from "@tutti-os/workspace-app-center";
import {
  normalizeWorkspaceAppCenterApp,
  normalizeWorkspaceAppCenterSnapshot,
  type DesktopWorkspaceAppCenterLocalFileGateway,
  type WorkspaceAppLike
} from "./desktopWorkspaceAppCenterGateway.ts";
import { WorkspaceAppCenterService } from "../workspaceAppCenterService.ts";

test("Workspace App Center gateway exposes launch URLs only for running apps", () => {
  const snapshot = normalizeWorkspaceAppCenterSnapshot(
    createWorkspaceAppListResponse({
      workspaceId: "workspace-1",
      apps: [
        {
          appId: "hello",
          description: "Hello app",
          displayName: "Hello",
          enabled: true,
          failureReason: null,
          iconUrl: null,
          installed: true,
          exportable: false,
          launchUrl: "http://127.0.0.1:12345",
          lastError: null,
          port: 12345,
          source: "builtin",
          stateRevision: 1,
          status: "preparing",
          startedAtUnixMs: 1,
          updatedAtUnixMs: 1,
          version: "0.1.0"
        },
        {
          appId: "ready",
          createdAtUnixMs: 20,
          description: "Ready app",
          displayName: "Ready",
          enabled: true,
          failureReason: null,
          iconUrl: "data:image/png;base64,AAAA",
          installed: true,
          exportable: true,
          launchUrl: "http://127.0.0.1:23456",
          lastError: null,
          port: 23456,
          source: "generated",
          stateRevision: 1,
          status: "running",
          startedAtUnixMs: 1,
          updatedAtUnixMs: 1,
          version: "0.1.0"
        }
      ]
    })
  );

  assert.equal(snapshot.catalogStatus, "ready");
  assert.equal(snapshot.apps[0]?.launchUrl, null);
  assert.equal(snapshot.apps[1]?.createdAtUnixMs, 20);
  assert.equal(snapshot.apps[1]?.iconUrl, "data:image/png;base64,AAAA");
  assert.equal(snapshot.apps[1]?.installationId, null);
  assert.equal(snapshot.apps[1]?.runtimeId, null);
  assert.equal(snapshot.apps[1]?.launchUrl, "http://127.0.0.1:23456");
});

test("Workspace App Center gateway preserves optional remote runtime ids", () => {
  const app: WorkspaceAppLike = {
    ...createWorkspaceApp({
      launchUrl: "https://preview.example/app",
      status: "running"
    }),
    installationId: "inst-1",
    runtimeId: "rt-1"
  };

  const normalized = normalizeWorkspaceAppCenterApp(app);

  assert.equal(normalized.installationId, "inst-1");
  assert.equal(normalized.runtimeId, "rt-1");
  assert.equal(normalized.launchUrl, "https://preview.example/app");
});

test("Workspace App Center gateway preserves app failure details", () => {
  const app = normalizeWorkspaceAppCenterApp(
    createWorkspaceApp({
      appId: "broken",
      failureReason: "install script exited 1",
      installed: false,
      lastError: "npm install failed",
      stateRevision: 2,
      status: "failed"
    })
  );

  assert.equal(app.runtimeStatus, "failed");
  assert.equal(app.failureReason, "install script exited 1");
  assert.equal(app.lastError, "npm install failed");
});

test("Workspace App Center gateway normalizes local-dev apps", () => {
  const app = normalizeWorkspaceAppCenterApp(
    createWorkspaceApp({
      appId: "local-dev",
      exportable: false,
      localPackageDir: "/Users/example/project/.tutti/dev-app",
      source: "local-dev"
    })
  );

  assert.equal(app.source, "local-dev");
  assert.equal(app.exportable, false);
  assert.equal(app.localPackageDir, "/Users/example/project/.tutti/dev-app");
});

test("Workspace App Center gateway preserves app window minimum size", () => {
  const app = normalizeWorkspaceAppCenterApp(
    createWorkspaceApp({
      windowMinHeight: 520,
      windowMinWidth: 720
    })
  );

  assert.equal(app.windowMinHeight, 520);
  assert.equal(app.windowMinWidth, 720);
});

test("Workspace App Center gateway maps unavailable runtime aliases", () => {
  const app = normalizeWorkspaceAppCenterApp(
    createWorkspaceApp({
      launchUrl: "https://preview.example/app",
      status: "runtime_unavailable" as WorkspaceApp["status"]
    })
  );

  assert.equal(app.runtimeStatus, "unavailable");
  assert.equal(app.launchUrl, null);
});

test("Workspace App Center gateway rejects unsupported app source enums", () => {
  assert.throws(
    () =>
      normalizeWorkspaceAppCenterSnapshot(
        createWorkspaceAppListResponse({
          workspaceId: "workspace-1",
          apps: [
            createWorkspaceApp({
              source: "unknown" as WorkspaceApp["source"]
            })
          ]
        })
      ),
    /Unsupported workspace app source/
  );
});

test("Workspace App Center service ignores stale app update events", async () => {
  const app = createWorkspaceApp({
    launchUrl: "http://127.0.0.1:23456",
    stateRevision: 2,
    status: "running"
  });
  const eventStreamClient = createFakeEventStreamClient();
  const service = new WorkspaceAppCenterService({
    eventStreamClient,
    gateway: {
      async installWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async deleteWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [],
            workspaceId: "workspace-1"
          })
        );
      },
      async exportWorkspaceApp() {
        return {
          appId: app.appId,
          archivePath: "/tmp/app.zip",
          artifactSha256: "0".repeat(64),
          artifactSizeBytes: 1,
          version: app.version,
          workspaceId: "workspace-1"
        };
      },
      async importWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async loadLocalWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async replaceWorkspaceAppIcon() {
        return normalizeWorkspaceAppCenterApp(app);
      },
      async reloadLocalWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async listWorkspaceApps() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async refreshWorkspaceAppCatalog() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async uninstallWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async launchWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async retryWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async rollbackWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async listWorkspaceAppFactoryJobs() {
        return { jobs: [] };
      },
      async createWorkspaceAppFactoryJob() {
        return { jobs: [] };
      },
      async cancelWorkspaceAppFactoryJob() {
        return { jobs: [] };
      },
      async deleteWorkspaceAppFactoryJob() {
        return { jobs: [] };
      },
      async retryWorkspaceAppFactoryJobValidation() {
        return { jobs: [] };
      },
      async fixWorkspaceAppFactoryJob() {
        return { jobs: [] };
      },
      async prepareWorkspaceAppFactoryJobModification() {
        return { jobs: [] };
      },
      async publishWorkspaceAppFactoryJob() {
        return {
          appSnapshot: normalizeWorkspaceAppCenterSnapshot(
            createWorkspaceAppListResponse({
              apps: [app],
              workspaceId: "workspace-1"
            })
          ),
          factorySnapshot: { jobs: [] }
        };
      },
      async startEnabledWorkspaceApps() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  const dispose = service.startWorkspacePolling("workspace-1");
  await settle();
  assert.equal(service.store.apps[0]?.runtimeStatus, "running");
  assert.equal(service.store.apps[0]?.stateRevision, 2);

  eventStreamClient.emitWorkspaceAppUpdated(
    createWorkspaceApp({
      launchUrl: null,
      stateRevision: 1,
      status: "idle"
    })
  );
  assert.equal(service.store.apps[0]?.runtimeStatus, "running");
  assert.equal(service.store.apps[0]?.stateRevision, 2);

  eventStreamClient.emitWorkspaceAppUpdated(
    createWorkspaceApp({
      launchUrl: null,
      stateRevision: 3,
      status: "failed"
    })
  );
  assert.equal(service.store.apps[0]?.runtimeStatus, "failed");
  assert.equal(service.store.apps[0]?.stateRevision, 3);
  dispose();
});

test("Workspace App Center service refreshes while remote catalog is loading", async () => {
  const embeddedApp = createWorkspaceApp({
    appId: "automation",
    displayName: "Automation",
    source: "builtin"
  });
  const remoteApp = createWorkspaceApp({
    appId: "vibe-design",
    displayName: "Vibe Design",
    source: "builtin"
  });
  const loadingSnapshot = {
    apps: [normalizeWorkspaceAppCenterApp(embeddedApp)],
    catalogLastError: null,
    catalogStatus: "loading" as const,
    catalogUpdatedAtUnixMs: null
  };
  const readySnapshot = {
    apps: [
      normalizeWorkspaceAppCenterApp(embeddedApp),
      normalizeWorkspaceAppCenterApp(remoteApp)
    ],
    catalogLastError: null,
    catalogStatus: "ready" as const,
    catalogUpdatedAtUnixMs: 1
  };
  let listCalls = 0;
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => embeddedApp),
      async listWorkspaceApps() {
        listCalls += 1;
        return listCalls >= 2 ? readySnapshot : loadingSnapshot;
      },
      async startEnabledWorkspaceApps() {
        return loadingSnapshot;
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  const dispose = service.startWorkspacePolling("workspace-1");
  await waitFor(() => service.store.catalogStatus === "ready");

  assert.equal(listCalls, 2);
  assert.equal(
    service.store.apps.some((app) => app.appId === "vibe-design"),
    true
  );
  dispose();
});

test("Workspace App Center service keeps async installs busy until the installed app appears", async () => {
  const remoteApp = createWorkspaceApp({
    appId: "vibe-design",
    displayName: "Vibe Design",
    enabled: false,
    installed: false,
    launchUrl: null,
    source: "builtin",
    stateRevision: 1,
    status: "idle"
  });
  const installedApp = createWorkspaceApp({
    appId: "vibe-design",
    displayName: "Vibe Design",
    enabled: true,
    installed: true,
    launchUrl: "http://127.0.0.1:45678",
    source: "builtin",
    stateRevision: 2,
    status: "running"
  });
  let listCalls = 0;
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => remoteApp),
      async installWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [remoteApp],
            workspaceId: "workspace-1"
          })
        );
      },
      async listWorkspaceApps() {
        listCalls += 1;
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [listCalls >= 2 ? installedApp : remoteApp],
            workspaceId: "workspace-1"
          })
        );
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  await service.refresh("workspace-1");
  await service.installApp({
    appId: "vibe-design",
    workspaceId: "workspace-1"
  });

  assert.equal(service.store.apps[0]?.runtimeStatus, "installing");
  assert.equal(service.store.apps[0]?.installed, false);

  await waitFor(() => service.store.apps[0]?.runtimeStatus === "running");
  assert.equal(service.store.apps[0]?.installed, true);
  assert.equal(service.store.apps[0]?.launchUrl, "http://127.0.0.1:45678");
});

test("Workspace App Center service keeps newer event state over stale install snapshots", async () => {
  const availableApp = createWorkspaceApp({
    appId: "gomoku",
    displayName: "Gomoku",
    enabled: false,
    installed: false,
    launchUrl: null,
    source: "generated",
    stateRevision: 12,
    status: "idle"
  });
  const staleStartingApp = createWorkspaceApp({
    appId: "gomoku",
    displayName: "Gomoku",
    enabled: true,
    installed: true,
    launchUrl: null,
    source: "generated",
    stateRevision: 14,
    status: "starting"
  });
  const runningApp = createWorkspaceApp({
    appId: "gomoku",
    displayName: "Gomoku",
    enabled: true,
    installed: true,
    launchUrl: "http://127.0.0.1:54860",
    source: "generated",
    stateRevision: 15,
    status: "running"
  });
  const eventStreamClient = createFakeEventStreamClient();
  const service = new WorkspaceAppCenterService({
    eventStreamClient,
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => availableApp),
      async installWorkspaceApp() {
        eventStreamClient.emitWorkspaceAppUpdated(runningApp);
        await settle();
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [staleStartingApp],
            workspaceId: "workspace-1"
          })
        );
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  await service.refresh("workspace-1");
  const dispose = service.startWorkspacePolling("workspace-1");
  await settle();
  await service.installApp({
    appId: "gomoku",
    workspaceId: "workspace-1"
  });

  assert.equal(service.store.apps[0]?.runtimeStatus, "running");
  assert.equal(service.store.apps[0]?.stateRevision, 15);
  assert.equal(service.store.apps[0]?.launchUrl, "http://127.0.0.1:54860");
  dispose();
});

test("Workspace App Center service refreshes stuck startup state after timeout", async () => {
  const idleApp = createWorkspaceApp({
    appId: "weather",
    launchUrl: null,
    stateRevision: 1,
    status: "idle"
  });
  const startingApp = createWorkspaceApp({
    appId: "weather",
    launchUrl: "http://127.0.0.1:45678",
    stateRevision: 2,
    status: "starting"
  });
  const runningApp = createWorkspaceApp({
    appId: "weather",
    launchUrl: "http://127.0.0.1:45678",
    stateRevision: 3,
    status: "running"
  });
  let listCalls = 0;
  let launchedAppId: string | null = null;
  const service = new WorkspaceAppCenterService({
    appOpenLaunchWaitTimeoutMs: 5,
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => idleApp),
      async listWorkspaceApps() {
        listCalls += 1;
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [listCalls >= 2 ? runningApp : idleApp],
            workspaceId: "workspace-1"
          })
        );
      },
      async launchWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [startingApp],
            workspaceId: "workspace-1"
          })
        );
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });
  service.setWorkspaceAppLauncher(async ({ appId }) => {
    launchedAppId = appId;
    return true;
  });

  await service.refresh("workspace-1");
  const openPromise = service.openApp({
    appId: "weather",
    workspaceId: "workspace-1"
  });
  await settle();

  assert.equal(service.store.apps[0]?.runtimeStatus, "starting");

  await openPromise;
  assert.equal(service.store.apps[0]?.launchUrl, "http://127.0.0.1:45678");
  assert.equal(launchedAppId, "weather");
});

test("Workspace App Center service marks startup failed when timeout refresh is still not running", async () => {
  const idleApp = createWorkspaceApp({
    appId: "weather",
    launchUrl: null,
    stateRevision: 1,
    status: "idle"
  });
  const startingApp = createWorkspaceApp({
    appId: "weather",
    launchUrl: "http://127.0.0.1:45678",
    stateRevision: 2,
    status: "starting"
  });
  let launchedAppId: string | null = null;
  const service = new WorkspaceAppCenterService({
    appOpenLaunchWaitTimeoutMs: 5,
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => idleApp),
      async listWorkspaceApps() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [startingApp],
            workspaceId: "workspace-1"
          })
        );
      },
      async launchWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [startingApp],
            workspaceId: "workspace-1"
          })
        );
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });
  service.setWorkspaceAppLauncher(async ({ appId }) => {
    launchedAppId = appId;
    return true;
  });

  await service.refresh("workspace-1");
  await service.openApp({
    appId: "weather",
    workspaceId: "workspace-1"
  });

  assert.equal(service.store.apps[0]?.runtimeStatus, "failed");
  assert.equal(launchedAppId, null);
});

test("Workspace App Center service refreshes remote catalog explicitly", async () => {
  const app = createWorkspaceApp({
    appId: "vibe-design",
    displayName: "Vibe Design",
    source: "builtin"
  });
  let refreshCalls = 0;
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => app),
      async refreshWorkspaceAppCatalog() {
        refreshCalls += 1;
        return {
          apps: [normalizeWorkspaceAppCenterApp(app)],
          catalogLastError: null,
          catalogStatus: "ready",
          catalogUpdatedAtUnixMs: 1
        };
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  await service.refreshCatalog("workspace-1");

  assert.equal(refreshCalls, 1);
  assert.equal(service.store.catalogStatus, "ready");
  assert.equal(service.store.apps[0]?.appId, "vibe-design");
});

test("Workspace App Center service reveals exported app archive", async () => {
  const app = createWorkspaceApp({
    appId: "exportable",
    displayName: "Exportable App",
    exportable: true,
    source: "generated",
    status: "idle",
    version: "0.2.0"
  });
  const revealedPaths: string[] = [];
  const exported: { destinationPath?: string; version?: string } = {};
  let selectedDefaultPath = "";
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => app),
      async exportWorkspaceApp(_workspaceId, _appId, input) {
        exported.destinationPath = input.destinationPath;
        exported.version = input.version;
        return {
          appId: app.appId,
          archivePath: input.destinationPath,
          artifactSha256: "0".repeat(64),
          artifactSizeBytes: 1,
          version: app.version,
          workspaceId: "workspace-1"
        };
      }
    },
    hostFilesApi: createFakeHostFilesApi({
      revealInFolder: async (path) => {
        revealedPaths.push(path);
      },
      selectAppArchiveExportPath: async (input) => {
        selectedDefaultPath = input.defaultPath;
        return "/tmp/exportable.zip";
      }
    }),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  await service.refresh("workspace-1");
  await service.exportApp({ appId: app.appId, workspaceId: "workspace-1" });

  assert.equal(exported.destinationPath, "/tmp/exportable.zip");
  assert.equal(exported.version, "0.2.0");
  assert.equal(selectedDefaultPath, "Exportable_App_0.2.0.zip");
  assert.deepEqual(revealedPaths, ["/tmp/exportable.zip"]);
});

test("Workspace App Center service records import failures", async () => {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => createWorkspaceApp({})),
      async importWorkspaceApp() {
        throw Object.assign(new Error("package exists"), {
          code: "invalid_request",
          reason: "workspace_app_package_exists"
        });
      }
    },
    hostFilesApi: createFakeHostFilesApi({
      selectAppArchive: async () => "/tmp/imported.zip"
    }),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  await service.importApp({ workspaceId: "workspace-1" });

  assert.equal(service.store.error, "This app version already exists.");
});

test("Workspace App Center service keeps factory jobs visible while publish is pending", async () => {
  const app = createWorkspaceApp({
    appId: "app_1",
    installed: true,
    launchUrl: "http://127.0.0.1:23456",
    source: "generated",
    status: "running"
  });
  const readyJob = createWorkspaceAppFactoryJob({
    appId: "app_1",
    jobId: "job-1",
    status: "ready",
    updatedAtUnixMs: 1
  });
  const publishedJob = createWorkspaceAppFactoryJob({
    ...readyJob,
    publishedVersion: "0.1.0",
    status: "published",
    updatedAtUnixMs: 2
  });
  let publishCalls = 0;
  let resolvePublish: (
    value: Awaited<
      ReturnType<WorkspaceAppCenterGateway["publishWorkspaceAppFactoryJob"]>
    >
  ) => void = () => {};
  const publishPromise = new Promise<
    Awaited<
      ReturnType<WorkspaceAppCenterGateway["publishWorkspaceAppFactoryJob"]>
    >
  >((resolve) => {
    resolvePublish = resolve;
  });
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(
        () => app,
        undefined,
        () => [readyJob]
      ),
      async publishWorkspaceAppFactoryJob() {
        publishCalls += 1;
        return publishPromise;
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  await service.refresh("workspace-1");
  assert.equal(service.store.factoryJobs.length, 1);

  const firstPublish = service.publishFactoryJob({
    jobId: "job-1",
    workspaceId: "workspace-1"
  });
  await settle();
  assert.equal(service.store.factoryJobs.length, 1);
  assert.equal(service.store.factoryJobs[0]?.status, "ready");

  await service.publishFactoryJob({
    jobId: "job-1",
    workspaceId: "workspace-1"
  });
  assert.equal(publishCalls, 1);

  resolvePublish({
    appSnapshot: normalizeWorkspaceAppCenterSnapshot(
      createWorkspaceAppListResponse({
        apps: [app],
        workspaceId: "workspace-1"
      })
    ),
    factorySnapshot: { jobs: [publishedJob] }
  });
  await firstPublish;

  assert.equal(service.store.factoryJobs[0]?.status, "published");
});

test("Workspace App Center service refreshes after reconnect when startup connect was already established", async () => {
  let app = createWorkspaceApp({
    launchUrl: null,
    stateRevision: 1,
    status: "idle"
  });
  let factoryJob = createWorkspaceAppFactoryJob({
    status: "generating",
    updatedAtUnixMs: 1
  });
  let listCalls = 0;
  const eventStreamClient = createFakeEventStreamClient({
    emitConnectedOnConnect: false
  });
  const service = new WorkspaceAppCenterService({
    eventStreamClient,
    gateway: createFakeWorkspaceAppCenterGateway(
      () => app,
      () => {
        listCalls += 1;
      },
      () => [factoryJob]
    ),
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  const dispose = service.startWorkspacePolling("workspace-1");
  await settle();
  assert.equal(listCalls, 1);
  assert.equal(service.store.apps[0]?.stateRevision, 1);
  assert.equal(service.store.factoryJobs[0]?.status, "generating");

  app = createWorkspaceApp({
    launchUrl: "http://127.0.0.1:23456",
    stateRevision: 2,
    status: "running"
  });
  factoryJob = createWorkspaceAppFactoryJob({
    status: "ready",
    updatedAtUnixMs: 2
  });
  eventStreamClient.emitConnectionState("connected");
  await settle();

  assert.equal(listCalls, 2);
  assert.equal(service.store.apps[0]?.runtimeStatus, "running");
  assert.equal(service.store.apps[0]?.stateRevision, 2);
  assert.equal(service.store.factoryJobs[0]?.status, "ready");
  assert.equal(service.store.factoryJobs[0]?.updatedAtUnixMs, 2);
  dispose();
});

test("Workspace App Center service does not launch deleted apps", async () => {
  const app = createWorkspaceApp({
    launchUrl: "http://127.0.0.1:23456",
    stateRevision: 1,
    status: "running"
  });
  let launchCalls = 0;
  const closedApps: string[] = [];
  const eventStreamClient = createFakeEventStreamClient();
  const service = new WorkspaceAppCenterService({
    eventStreamClient,
    gateway: createFakeWorkspaceAppCenterGateway(
      () => app,
      undefined,
      undefined,
      () => []
    ),
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });
  service.setWorkspaceAppLauncher(async () => {
    launchCalls += 1;
    return true;
  });
  service.setWorkspaceAppViewCloser(({ appId }) => {
    closedApps.push(appId);
  });

  await service.refresh("workspace-1");
  assert.equal(service.store.apps.length, 1);

  await service.deleteApp({ appId: "ready", workspaceId: "workspace-1" });
  assert.equal(service.store.apps.length, 0);
  assert.deepEqual(closedApps, ["ready"]);

  eventStreamClient.emitWorkspaceAppUpdated(
    createWorkspaceApp({
      launchUrl: null,
      stateRevision: 2,
      status: "idle"
    })
  );
  assert.equal(service.store.apps.length, 0);

  await service.openApp({ appId: "ready", workspaceId: "workspace-1" });
  assert.equal(launchCalls, 0);
});

test("Workspace App Center service records delete failures", async () => {
  const app = createWorkspaceApp({
    source: "builtin"
  });
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => app),
      async deleteWorkspaceApp() {
        throw Object.assign(new Error("cannot delete builtin app"), {
          code: "invalid_request",
          reason: "workspace_app_delete_forbidden"
        });
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });

  await service.refresh("workspace-1");
  await service.deleteApp({ appId: "ready", workspaceId: "workspace-1" });

  assert.equal(service.store.apps.length, 1);
  assert.equal(service.store.error, "That request could not be completed.");
});

test("Workspace App Center service closes uninstalled app views", async () => {
  const app = createWorkspaceApp({
    launchUrl: "http://127.0.0.1:23456",
    stateRevision: 1,
    status: "running"
  });
  const closedApps: string[] = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => app),
      async uninstallWorkspaceApp() {
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [
              createWorkspaceApp({
                enabled: false,
                installed: false,
                launchUrl: null,
                port: null,
                stateRevision: 2,
                status: "idle"
              })
            ],
            workspaceId: "workspace-1"
          })
        );
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });
  service.setWorkspaceAppViewCloser(({ appId }) => {
    closedApps.push(appId);
  });

  await service.refresh("workspace-1");
  await service.uninstallApp({ appId: "ready", workspaceId: "workspace-1" });

  assert.equal(service.store.apps[0]?.installed, false);
  assert.deepEqual(closedApps, ["ready"]);
});

test("Workspace App Center service closes stale app view before restart and open", async () => {
  let app = createWorkspaceApp({
    launchUrl: "http://127.0.0.1:23456",
    stateRevision: 1,
    status: "installed_pending_restart" as WorkspaceApp["status"],
    version: "0.1.12"
  });
  const calls: string[] = [];
  const service = new WorkspaceAppCenterService({
    appOpenLaunchWaitTimeoutMs: 1,
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => app),
      async installWorkspaceApp(_workspaceId, _appId, input) {
        calls.push(`install:${String(input?.restartRunning)}`);
        app = createWorkspaceApp({
          launchUrl: "http://127.0.0.1:23456",
          stateRevision: 2,
          status: "running",
          version: "0.1.12"
        });
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });
  service.setWorkspaceAppViewCloser(({ appId }) => {
    calls.push(`close:${appId}`);
  });
  service.setWorkspaceAppLauncher(async ({ appId, prepared }) => {
    calls.push(`launch:${appId}:${String(prepared)}`);
    return true;
  });

  await service.refresh("workspace-1");
  const opened = await service.restartAndOpenApp({
    appId: "ready",
    workspaceId: "workspace-1"
  });

  assert.equal(opened, true);
  assert.deepEqual(calls, ["close:ready", "install:true", "launch:ready:true"]);
});

test("Workspace App Center service launches already-running apps without restarting them", async () => {
  let app = createWorkspaceApp({
    launchUrl: "http://127.0.0.1:23456",
    stateRevision: 1,
    status: "running"
  });
  let gatewayLaunchCalls = 0;
  let retryCalls = 0;
  const launchCalls: Array<{
    appId: string;
    prepared: boolean;
    prevStatus?: WorkspaceAppCenterRuntimeStatus;
    workspaceId: string;
  }> = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => app),
      async launchWorkspaceApp() {
        gatewayLaunchCalls += 1;
        app = createWorkspaceApp({
          launchUrl: null,
          stateRevision: 2,
          status: "preparing"
        });
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async retryWorkspaceApp() {
        retryCalls += 1;
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });
  service.setWorkspaceAppLauncher(async (input) => {
    launchCalls.push(input);
    return true;
  });

  await service.refresh("workspace-1");
  await service.openApp({
    appId: "ready",
    workspaceId: "workspace-1"
  });

  assert.equal(retryCalls, 0);
  assert.equal(gatewayLaunchCalls, 0);
  assert.deepEqual(launchCalls, [
    {
      appId: "ready",
      prepared: true,
      prevStatus: "running",
      workspaceId: "workspace-1"
    }
  ]);
});

test("Workspace App Center service starts non-running apps before launching them", async () => {
  let app = createWorkspaceApp({
    launchUrl: null,
    port: null,
    stateRevision: 1,
    status: "idle"
  });
  let gatewayLaunchCalls = 0;
  let retryCalls = 0;
  const launchCalls: Array<{
    appId: string;
    prepared: boolean;
    prevStatus?: WorkspaceAppCenterRuntimeStatus;
    workspaceId: string;
  }> = [];
  const service = new WorkspaceAppCenterService({
    eventStreamClient: createFakeEventStreamClient(),
    gateway: {
      ...createFakeWorkspaceAppCenterGateway(() => app),
      async launchWorkspaceApp() {
        gatewayLaunchCalls += 1;
        app = createWorkspaceApp({
          launchUrl: null,
          port: null,
          stateRevision: 2,
          status: "preparing"
        });
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      },
      async retryWorkspaceApp() {
        retryCalls += 1;
        return normalizeWorkspaceAppCenterSnapshot(
          createWorkspaceAppListResponse({
            apps: [app],
            workspaceId: "workspace-1"
          })
        );
      }
    },
    hostFilesApi: createFakeHostFilesApi(),
    hostWorkspaceApi: {
      async openWorkspaceAppFolder() {}
    }
  });
  service.setWorkspaceAppLauncher(async (input) => {
    launchCalls.push(input);
    return true;
  });

  await service.refresh("workspace-1");
  const openPromise = service.openApp({
    appId: "ready",
    workspaceId: "workspace-1"
  });
  await settle();

  assert.equal(gatewayLaunchCalls, 1);
  assert.equal(retryCalls, 0);
  assert.equal(launchCalls.length, 0);

  app = createWorkspaceApp({
    launchUrl: "http://127.0.0.1:34567",
    port: 34567,
    stateRevision: 3,
    status: "running"
  });
  await service.refresh("workspace-1");
  await openPromise;

  assert.deepEqual(launchCalls, [
    {
      appId: "ready",
      prepared: true,
      prevStatus: "idle",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(service.store.apps[0]?.launchUrl, "http://127.0.0.1:34567");
});

function createWorkspaceApp(overrides: Partial<WorkspaceApp>): WorkspaceApp {
  return {
    appId: "ready",
    authors: [],
    availableIconUrl: null,
    availableVersion: null,
    cli: {
      active: false,
      issues: [],
      scope: null,
      status: "none"
    },
    createdAtUnixMs: 1,
    description: "Ready app",
    displayName: "Ready",
    enabled: true,
    exportable: true,
    failureReason: null,
    iconUrl: null,
    installed: true,
    launchUrl: "http://127.0.0.1:23456",
    lastError: null,
    localizations: [],
    minimizeBehavior: "keep-mounted",
    port: 23456,
    source: "generated",
    stateRevision: 1,
    status: "running",
    tags: [],
    updateAvailable: false,
    startedAtUnixMs: 1,
    updatedAtUnixMs: 1,
    version: "0.1.0",
    windowMinHeight: null,
    windowMinWidth: null,
    ...overrides,
    references: overrides.references ?? {
      listSupported: false,
      searchSupported: false
    }
  };
}

function createWorkspaceAppListResponse(input: {
  apps: Partial<WorkspaceApp>[];
  catalogStatus?: WorkspaceAppListResponse["catalogStatus"];
  workspaceId: string;
}): WorkspaceAppListResponse {
  return {
    apps: input.apps.map((app) => createWorkspaceApp(app)),
    catalogStatus: input.catalogStatus ?? {
      lastError: null,
      status: "ready",
      updatedAtUnixMs: null
    },
    workspaceId: input.workspaceId
  };
}

function createFakeHostFilesApi(
  overrides: Partial<{
    openExternal(url: string): Promise<void>;
    revealInFolder(path: string): Promise<void>;
    selectAppArchive(): Promise<string | null>;
    selectAppArchiveExportPath(input: {
      defaultPath: string;
    }): Promise<string | null>;
    selectDirectory(): Promise<string | null>;
    selectAppIconImage(): Promise<string | null>;
  }> = {}
): {
  openExternal(url: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;
  selectAppArchive(): Promise<string | null>;
  selectAppArchiveExportPath(input: {
    defaultPath: string;
  }): Promise<string | null>;
  selectDirectory(): Promise<string | null>;
  selectAppIconImage(): Promise<string | null>;
} {
  return {
    async openExternal() {},
    async revealInFolder() {},
    async selectAppArchive() {
      return "/tmp/app.zip";
    },
    async selectAppArchiveExportPath(input) {
      return input.defaultPath;
    },
    async selectDirectory() {
      return null;
    },
    async selectAppIconImage() {
      return "/tmp/icon.png";
    },
    ...overrides
  };
}

function createWorkspaceAppFactoryJob(
  overrides: Partial<WorkspaceAppFactoryJob> = {}
): WorkspaceAppFactoryJob {
  return {
    appId: null,
    createdAtUnixMs: 1,
    description: null,
    displayName: "Draft app",
    failureReason: null,
    jobId: "job-1",
    model: "gpt-5",
    prompt: "Build an app",
    provider: "codex",
    publishedVersion: null,
    status: "generating",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1",
    ...overrides
  };
}

function createFakeWorkspaceAppCenterGateway(
  getApp: () => WorkspaceApp,
  onListWorkspaceApps?: () => void,
  getFactoryJobs: () => WorkspaceAppFactoryJob[] = () => [],
  getDeletedApps: () => WorkspaceApp[] = () => []
): WorkspaceAppCenterGateway & DesktopWorkspaceAppCenterLocalFileGateway {
  const snapshot = (apps: readonly WorkspaceApp[] = [getApp()]) =>
    normalizeWorkspaceAppCenterSnapshot(
      createWorkspaceAppListResponse({
        apps: [...apps],
        workspaceId: "workspace-1"
      })
    );
  return {
    async installWorkspaceApp() {
      return snapshot();
    },
    async exportWorkspaceApp() {
      const app = getApp();
      return {
        appId: app.appId,
        archivePath: "/tmp/app.zip",
        artifactSha256: "0".repeat(64),
        artifactSizeBytes: 1,
        version: app.version,
        workspaceId: "workspace-1"
      };
    },
    async importWorkspaceApp() {
      return snapshot();
    },
    async loadLocalWorkspaceApp() {
      return snapshot();
    },
    async replaceWorkspaceAppIcon() {
      return normalizeWorkspaceAppCenterApp(getApp());
    },
    async reloadLocalWorkspaceApp() {
      return snapshot();
    },
    async listWorkspaceApps() {
      onListWorkspaceApps?.();
      return snapshot();
    },
    async refreshWorkspaceAppCatalog() {
      return snapshot();
    },
    async uninstallWorkspaceApp() {
      return snapshot();
    },
    async deleteWorkspaceApp() {
      return snapshot(getDeletedApps());
    },
    async launchWorkspaceApp() {
      return snapshot();
    },
    async retryWorkspaceApp() {
      return snapshot();
    },
    async rollbackWorkspaceApp() {
      return snapshot();
    },
    async listWorkspaceAppFactoryJobs() {
      return { jobs: getFactoryJobs() };
    },
    async createWorkspaceAppFactoryJob() {
      return { jobs: getFactoryJobs() };
    },
    async cancelWorkspaceAppFactoryJob() {
      return { jobs: getFactoryJobs() };
    },
    async deleteWorkspaceAppFactoryJob() {
      return { jobs: getFactoryJobs() };
    },
    async retryWorkspaceAppFactoryJobValidation() {
      return { jobs: getFactoryJobs() };
    },
    async fixWorkspaceAppFactoryJob() {
      return { jobs: getFactoryJobs() };
    },
    async prepareWorkspaceAppFactoryJobModification() {
      return { jobs: getFactoryJobs() };
    },
    async publishWorkspaceAppFactoryJob() {
      return {
        appSnapshot: snapshot(),
        factorySnapshot: { jobs: getFactoryJobs() }
      };
    },
    async startEnabledWorkspaceApps() {
      return snapshot();
    }
  };
}

function createFakeEventStreamClient(options?: {
  emitConnectedOnConnect?: boolean;
}): TuttidEventStreamClient & {
  emitConnectionState(
    state: Parameters<
      Parameters<TuttidEventStreamClient["subscribeConnectionState"]>[0]
    >[0]
  ): void;
  emitWorkspaceAppUpdated(app: WorkspaceApp): void;
} {
  const appListeners = new Set<
    (event: {
      emittedAt: string;
      id: string;
      payload: { app: WorkspaceApp };
      scope: { workspaceId: string };
      topic: "workspace.app.updated";
      version: 1;
    }) => void
  >();
  const connectionStateListeners = new Set<
    Parameters<TuttidEventStreamClient["subscribeConnectionState"]>[0]
  >();

  return {
    async connect() {
      if (options?.emitConnectedOnConnect === false) {
        return;
      }
      for (const listener of connectionStateListeners) {
        listener("connected");
      }
    },
    dispose() {},
    emitConnectionState(state) {
      for (const listener of connectionStateListeners) {
        listener(state);
      }
    },
    emitWorkspaceAppUpdated(app) {
      for (const listener of appListeners) {
        listener({
          emittedAt: "2026-06-02T00:00:00Z",
          id: "evt-app",
          payload: { app },
          scope: { workspaceId: "workspace-1" },
          topic: "workspace.app.updated",
          version: 1
        });
      }
    },
    async publishIntent() {},
    subscribe(topic, listener) {
      if (topic !== "workspace.app.updated") {
        return () => {};
      }
      appListeners.add(
        listener as unknown as Parameters<typeof appListeners.add>[0]
      );
      return () => {
        appListeners.delete(
          listener as unknown as Parameters<typeof appListeners.add>[0]
        );
      };
    },
    subscribeConnectionState(listener) {
      connectionStateListeners.add(listener);
      return () => {
        connectionStateListeners.delete(listener);
      };
    }
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
