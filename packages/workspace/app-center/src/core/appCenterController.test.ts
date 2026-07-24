import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterGateway,
  WorkspaceAppCenterSnapshot,
  WorkspaceAppFactoryJob,
  WorkspaceAppFactorySnapshot
} from "../contracts/host.ts";
import {
  areWorkspaceAppCenterAppsEqual,
  areWorkspaceAppCenterViewStatesEqual,
  normalizeWorkspaceAppCenterViewState
} from "./appCenterControllerHelpers.ts";
import { createWorkspaceAppCenterController } from "./index.ts";

test("app-center view state preserves normalized inline app tabs", () => {
  const selected = normalizeWorkspaceAppCenterViewState({
    activeAppTab: "community",
    openAppId: "  group-chat  ",
    openAppIds: [" ai-slide ", "group-chat", "ai-slide", " "]
  });

  assert.deepEqual(selected, {
    activeAppTab: "community",
    openAppId: "group-chat",
    openAppIds: ["ai-slide", "group-chat"]
  });
  assert.equal(
    areWorkspaceAppCenterViewStatesEqual(selected, {
      activeAppTab: "community",
      openAppId: "group-chat",
      openAppIds: ["ai-slide", "group-chat"]
    }),
    true
  );
});

test("app-center view state restores a legacy inline app as its only tab", () => {
  assert.deepEqual(
    normalizeWorkspaceAppCenterViewState({
      activeAppTab: "recommended",
      openAppId: "ai-doc"
    }),
    {
      activeAppTab: "recommended",
      openAppId: "ai-doc",
      openAppIds: ["ai-doc"]
    }
  );
});

test("WorkspaceAppCenterController merges catalog fields without runtime regression", () => {
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway()
  });

  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          availableVersion: null,
          runtimeStatus: "running",
          stateRevision: 3,
          updateAvailable: false,
          version: "1.0.0"
        })
      ]
    })
  );
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          availableVersion: "1.1.0",
          runtimeStatus: "idle",
          stateRevision: 3,
          updateAvailable: true,
          version: "1.0.0"
        })
      ]
    })
  );

  assert.equal(controller.store.apps[0]?.availableVersion, "1.1.0");
  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
  assert.equal(controller.store.apps[0]?.updateAvailable, true);
});

test("WorkspaceAppCenterController accepts running snapshots after daemon revision reset", () => {
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway()
  });

  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          launchUrl: null,
          runtimeStatus: "preparing",
          stateRevision: 100
        })
      ]
    })
  );
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          launchUrl: "http://127.0.0.1:3000",
          runtimeStatus: "running",
          stateRevision: 3
        })
      ]
    })
  );

  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
  assert.equal(controller.store.apps[0]?.launchUrl, "http://127.0.0.1:3000");
  assert.equal(controller.store.apps[0]?.stateRevision, 3);
});

test("WorkspaceAppCenterController asks host to close removed installed apps", () => {
  const closeRequests: Array<{
    appIds: readonly string[];
    workspaceId: string;
  }> = [];
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway(),
    hooks: {
      onCloseWorkspaceAppViews(input) {
        closeRequests.push(input);
      }
    }
  });

  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ appId: "app-1", installed: true })]
    })
  );
  controller.applySnapshot("workspace-1", createSnapshot({ apps: [] }));

  assert.deepEqual(closeRequests, [
    {
      appIds: ["app-1"],
      workspaceId: "workspace-1"
    }
  ]);
});

test("WorkspaceAppCenterController ignores late app events after delete", async () => {
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway({
      async deleteWorkspaceApp() {
        return createSnapshot();
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [createApp({ stateRevision: 1 })] })
  );

  await controller.deleteApp({ appId: "app-1", workspaceId: "workspace-1" });
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "running", stateRevision: 2 }),
    workspaceId: "workspace-1"
  });

  assert.deepEqual(controller.store.apps, []);
});

test("WorkspaceAppCenterController app equality tracks runtime identity fields", () => {
  const app = createApp({
    installationId: "inst-1",
    runtimeId: "rt-1"
  });

  assert.equal(areWorkspaceAppCenterAppsEqual([app], [app]), true);
  assert.equal(
    areWorkspaceAppCenterAppsEqual(
      [app],
      [
        {
          ...app,
          installationId: "inst-2"
        }
      ]
    ),
    false
  );
  assert.equal(
    areWorkspaceAppCenterAppsEqual(
      [app],
      [
        {
          ...app,
          runtimeId: "rt-2"
        }
      ]
    ),
    false
  );
});

test("WorkspaceAppCenterController sorts factory jobs and reports snapshot application", () => {
  const appliedSnapshots: Array<{
    nextJobs: readonly WorkspaceAppFactoryJob[];
    previousJobs: readonly WorkspaceAppFactoryJob[];
    workspaceId: string;
  }> = [];
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway(),
    hooks: {
      onFactorySnapshotApplied(input) {
        appliedSnapshots.push(input);
      }
    }
  });

  controller.applyFactorySnapshot(
    "workspace-1",
    createFactorySnapshot({
      jobs: [
        createFactoryJob({ jobId: "job-old", updatedAtUnixMs: 1 }),
        createFactoryJob({ jobId: "job-new", updatedAtUnixMs: 2 })
      ]
    })
  );

  assert.deepEqual(
    controller.store.factoryJobs.map((job) => job.jobId),
    ["job-new", "job-old"]
  );
  assert.equal(appliedSnapshots.length, 1);
  assert.equal(appliedSnapshots[0]?.workspaceId, "workspace-1");
  assert.deepEqual(
    appliedSnapshots[0]?.nextJobs.map((job) => job.jobId),
    ["job-new", "job-old"]
  );
});

test("WorkspaceAppCenterController discards an older factory refresh after an authoritative snapshot", async () => {
  let resolveFactoryRefresh: (
    snapshot: WorkspaceAppFactorySnapshot
  ) => void = () => {};
  const factoryRefresh = new Promise<WorkspaceAppFactorySnapshot>((resolve) => {
    resolveFactoryRefresh = resolve;
  });
  const discarded: string[] = [];
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway({
      async listWorkspaceAppFactoryJobs() {
        return factoryRefresh;
      }
    }),
    hooks: {
      onRefreshDiscard(input) {
        discarded.push(input.snapshotKind);
      }
    }
  });

  const refresh = controller.refresh("workspace-1");
  controller.applyFactorySnapshot(
    "workspace-1",
    createFactorySnapshot({
      jobs: [createFactoryJob({ status: "generating", updatedAtUnixMs: 2 })]
    })
  );
  resolveFactoryRefresh(createFactorySnapshot());
  await refresh;

  assert.equal(controller.store.factoryJobs[0]?.status, "generating");
  assert.deepEqual(discarded, ["factory_jobs"]);
});

test("WorkspaceAppCenterController treats agent target changes as factory state changes", () => {
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway()
  });
  controller.applyFactorySnapshot(
    "workspace-1",
    createFactorySnapshot({
      jobs: [createFactoryJob({ agentTargetId: "target-1" })]
    })
  );

  controller.applyFactorySnapshot(
    "workspace-1",
    createFactorySnapshot({
      jobs: [createFactoryJob({ agentTargetId: "target-2" })]
    })
  );

  assert.equal(controller.store.factoryJobs[0]?.agentTargetId, "target-2");
});

test("WorkspaceAppCenterController keeps a factory job visible while publish is pending", async () => {
  const readyJob = createFactoryJob({ status: "ready" });
  let resolvePublish: (
    result: Awaited<
      ReturnType<WorkspaceAppCenterGateway["publishWorkspaceAppFactoryJob"]>
    >
  ) => void = () => {};
  const publishResult = new Promise<
    Awaited<
      ReturnType<WorkspaceAppCenterGateway["publishWorkspaceAppFactoryJob"]>
    >
  >((resolve) => {
    resolvePublish = resolve;
  });
  let publishCalls = 0;
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway({
      async publishWorkspaceAppFactoryJob() {
        publishCalls += 1;
        return publishResult;
      }
    })
  });

  controller.applyFactorySnapshot(
    "workspace-1",
    createFactorySnapshot({ jobs: [readyJob] })
  );
  const firstPublish = controller.publishFactoryJob({
    jobId: readyJob.jobId,
    workspaceId: "workspace-1"
  });

  assert.deepEqual(controller.store.factoryJobs, [readyJob]);
  assert.equal(
    await controller.publishFactoryJob({
      jobId: readyJob.jobId,
      workspaceId: "workspace-1"
    }),
    null
  );
  assert.equal(publishCalls, 1);

  const publishedJob = createFactoryJob({ status: "published" });
  resolvePublish({
    appSnapshot: createSnapshot(),
    factorySnapshot: createFactorySnapshot({ jobs: [publishedJob] })
  });
  assert.equal(await firstPublish, publishedJob);
  assert.deepEqual(controller.store.factoryJobs, [publishedJob]);
});

test("WorkspaceAppCenterController reports a create-factory-job failure instead of throwing", async () => {
  const failures: Array<{
    error: unknown;
    toastMessage: string;
  }> = [];
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async createWorkspaceAppFactoryJob() {
        throw new Error("agent target id is required for agent session launch");
      }
    }),
    hooks: {
      onOperationFailure(input) {
        failures.push({ error: input.error, toastMessage: input.toastMessage });
      }
    }
  });

  await controller.createFactoryJob({
    agentTargetId: "local:codex",
    displayName: "My App",
    prompt: "build me an app",
    workspaceId: "workspace-1"
  });

  assert.equal(controller.store.factoryJobs.length, 0);
  assert.equal(
    controller.store.error,
    "agent target id is required for agent session launch"
  );
  assert.equal(failures.length, 1);
  assert.equal(
    failures[0]?.toastMessage,
    "agent target id is required for agent session launch"
  );
});

test("WorkspaceAppCenterController creates one client submit id per factory action", async () => {
  const calls: Array<{
    clientSubmitId: string;
    displayName: string;
    workspaceId: string;
  }> = [];
  let idSequence = 0;
  const controller = createWorkspaceAppCenterController({
    createClientSubmitId: () => `factory-submit-${++idSequence}`,
    formatError,
    gateway: createGateway({
      async createWorkspaceAppFactoryJob(workspaceId, input) {
        calls.push({
          clientSubmitId: input.clientSubmitId,
          displayName: input.displayName,
          workspaceId
        });
        return createFactorySnapshot();
      }
    })
  });

  await controller.createFactoryJob({
    agentTargetId: "local:codex",
    displayName: "First App",
    prompt: "build the first app",
    workspaceId: "workspace-1"
  });
  await controller.createFactoryJob({
    agentTargetId: "local:codex",
    displayName: "Second App",
    prompt: "build the second app",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(calls, [
    {
      clientSubmitId: "factory-submit-1",
      displayName: "First App",
      workspaceId: "workspace-1"
    },
    {
      clientSubmitId: "factory-submit-2",
      displayName: "Second App",
      workspaceId: "workspace-1"
    }
  ]);
});

test("WorkspaceAppCenterController prepares app launch through launch gateway", async () => {
  const launchCalls: Array<{ appId: string; workspaceId: string }> = [];
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async launchWorkspaceApp(workspaceId, appId) {
        launchCalls.push({ appId, workspaceId });
        return createSnapshot({
          apps: [
            createApp({
              appId,
              launchUrl: "http://127.0.0.1:3000",
              runtimeStatus: "running",
              stateRevision: 2
            })
          ]
        });
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [createApp({ appId: "app-1" })] })
  );

  const app = await controller.prepareAppLaunch({
    appId: "app-1",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(launchCalls, [
    { appId: "app-1", workspaceId: "workspace-1" }
  ]);
  assert.equal(app?.runtimeStatus, "running");
  assert.equal(app?.launchUrl, "http://127.0.0.1:3000");
});

test("WorkspaceAppCenterController reuses an already-running launch without calling the gateway", async () => {
  let launchCalls = 0;
  const runningApp = createApp({
    launchUrl: "http://127.0.0.1:3000",
    runtimeStatus: "running"
  });
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway({
      async launchWorkspaceApp() {
        launchCalls += 1;
        return createSnapshot();
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [runningApp] })
  );

  assert.equal(
    await controller.prepareAppLaunch({
      appId: "app-1",
      workspaceId: "workspace-1"
    }),
    runningApp
  );
  assert.equal(launchCalls, 0);
});

test("WorkspaceAppCenterController refreshes launch state after a wait timeout", async () => {
  const controller = createWorkspaceAppCenterController({
    appOpenLaunchWaitTimeoutMs: 1,
    formatError,
    gateway: createGateway({
      async launchWorkspaceApp() {
        return createSnapshot({
          apps: [createApp({ runtimeStatus: "starting", stateRevision: 2 })]
        });
      },
      async listWorkspaceApps() {
        return createSnapshot({
          apps: [
            createApp({
              launchUrl: "http://127.0.0.1:3000",
              runtimeStatus: "running",
              stateRevision: 3
            })
          ]
        });
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [createApp()] })
  );

  const app = await controller.prepareAppLaunch({
    appId: "app-1",
    workspaceId: "workspace-1"
  });

  assert.equal(app?.runtimeStatus, "running");
  assert.equal(app?.launchUrl, "http://127.0.0.1:3000");
});

test("WorkspaceAppCenterController marks launch failed when timeout refresh stays transient", async () => {
  const startingSnapshot = createSnapshot({
    apps: [createApp({ runtimeStatus: "starting", stateRevision: 2 })]
  });
  const controller = createWorkspaceAppCenterController({
    appOpenLaunchWaitTimeoutMs: 1,
    formatError,
    gateway: createGateway({
      async launchWorkspaceApp() {
        return startingSnapshot;
      },
      async listWorkspaceApps() {
        return startingSnapshot;
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [createApp()] })
  );

  assert.equal(
    await controller.prepareAppLaunch({
      appId: "app-1",
      workspaceId: "workspace-1"
    }),
    null
  );
  assert.equal(controller.store.apps[0]?.runtimeStatus, "failed");
});

test("WorkspaceAppCenterController restores app state when launch preparation fails", async () => {
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async launchWorkspaceApp() {
        throw new Error("launch rejected");
      },
      async listWorkspaceApps() {
        throw new Error("list rejected");
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ appId: "app-1", runtimeStatus: "idle" })]
    })
  );

  const app = await controller.prepareAppLaunch({
    appId: "app-1",
    workspaceId: "workspace-1"
  });

  assert.equal(app, null);
  assert.equal(controller.store.apps[0]?.runtimeStatus, "idle");
  assert.equal(controller.store.error, "launch rejected");
});

test("WorkspaceAppCenterController refreshes app state when launch preparation finds a failed runtime", async () => {
  let listCalls = 0;
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async launchWorkspaceApp() {
        throw new Error("launch rejected");
      },
      async listWorkspaceApps() {
        listCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              failureReason: "process_exit",
              lastError: "exit status 1",
              runtimeStatus: "failed",
              stateRevision: 2
            })
          ]
        });
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ appId: "app-1", runtimeStatus: "idle" })]
    })
  );

  const app = await controller.prepareAppLaunch({
    appId: "app-1",
    workspaceId: "workspace-1"
  });

  assert.equal(app, null);
  assert.equal(listCalls, 1);
  assert.equal(controller.store.apps[0]?.runtimeStatus, "failed");
  assert.equal(controller.store.apps[0]?.lastError, "exit status 1");
  assert.equal(controller.store.error, "launch rejected");
});

test("WorkspaceAppCenterController retries failed apps through retry gateway", async () => {
  const retryCalls: Array<{ appId: string; workspaceId: string }> = [];
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async retryWorkspaceApp(workspaceId, appId) {
        retryCalls.push({ appId, workspaceId });
        return createSnapshot({
          apps: [
            createApp({
              appId,
              launchUrl: "http://127.0.0.1:3000",
              runtimeStatus: "running",
              stateRevision: 2
            })
          ]
        });
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ appId: "app-1", runtimeStatus: "failed" })]
    })
  );

  await controller.retryApp({ appId: "app-1", workspaceId: "workspace-1" });

  assert.deepEqual(retryCalls, [
    { appId: "app-1", workspaceId: "workspace-1" }
  ]);
  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
});

test("WorkspaceAppCenterController restores failed app state when retry fails", async () => {
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async retryWorkspaceApp() {
        throw new Error("retry rejected");
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ appId: "app-1", runtimeStatus: "failed" })]
    })
  );

  await controller.retryApp({ appId: "app-1", workspaceId: "workspace-1" });

  assert.equal(controller.store.apps[0]?.runtimeStatus, "failed");
  assert.equal(controller.store.error, "retry rejected");
});

test("WorkspaceAppCenterController ignores retry for non-failed apps", async () => {
  let retryCalls = 0;
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async retryWorkspaceApp() {
        retryCalls += 1;
        return createSnapshot();
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ appId: "app-1", runtimeStatus: "idle" })]
    })
  );

  await controller.retryApp({ appId: "app-1", workspaceId: "workspace-1" });

  assert.equal(retryCalls, 0);
  assert.equal(controller.store.apps[0]?.runtimeStatus, "idle");
});

test("WorkspaceAppCenterController requests restart without closing views when updating a running installed app", async () => {
  const installInputs: Array<{ restartRunning?: boolean } | undefined> = [];
  const closeRequests: Array<{
    appIds: readonly string[];
    workspaceId: string;
  }> = [];
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async installWorkspaceApp(_workspaceId, _appId, input) {
        installInputs.push(input);
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              availableVersion: null,
              runtimeStatus: "preparing",
              stateRevision: 2,
              updateAvailable: false,
              version: "1.1.0"
            })
          ]
        });
      }
    }),
    hooks: {
      onCloseWorkspaceAppViews(input) {
        closeRequests.push(input);
      }
    }
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          availableVersion: "1.1.0",
          runtimeStatus: "running",
          updateAvailable: true,
          version: "1.0.0"
        })
      ]
    })
  );

  await controller.updateApp({
    appId: "app-1",
    trigger: "primary_action",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(installInputs, [{ restartRunning: true }]);
  assert.deepEqual(closeRequests, []);
  controller.applyAppUpdate({
    app: createApp({
      appId: "app-1",
      availableVersion: null,
      runtimeStatus: "running",
      stateRevision: 3,
      updateAvailable: false,
      version: "1.1.0"
    }),
    workspaceId: "workspace-1"
  });
  assert.deepEqual(closeRequests, []);
});

test("WorkspaceAppCenterController deduplicates a pending update", async () => {
  let installCalls = 0;
  let resolveInstall: (snapshot: WorkspaceAppCenterSnapshot) => void = () => {};
  const installResult = new Promise<WorkspaceAppCenterSnapshot>((resolve) => {
    resolveInstall = resolve;
  });
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway({
      async installWorkspaceApp() {
        installCalls += 1;
        return installResult;
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [createApp({ updateAvailable: true })] })
  );

  const firstUpdate = controller.updateApp({
    appId: "app-1",
    trigger: "primary_action",
    workspaceId: "workspace-1"
  });
  await controller.updateApp({
    appId: "app-1",
    trigger: "primary_action",
    workspaceId: "workspace-1"
  });

  assert.equal(installCalls, 1);
  resolveInstall(
    createSnapshot({
      apps: [createApp({ updateAvailable: false, version: "1.1.0" })]
    })
  );
  await firstUpdate;
});

test("WorkspaceAppCenterController preserves install progress during pending install app updates", async () => {
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async installWorkspaceApp() {
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installProgress: {
                downloadedBytes: 1024,
                indeterminate: false,
                overallPercent: 72,
                totalBytes: 2048,
                userPhase: "downloading"
              },
              installed: false,
              runtimeStatus: "installing",
              stateRevision: 2
            })
          ]
        });
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          installed: false,
          runtimeStatus: "idle"
        })
      ]
    })
  );

  await controller.installApp({
    appId: "app-1",
    workspaceId: "workspace-1"
  });

  controller.applyAppUpdate({
    app: createApp({
      appId: "app-1",
      installed: true,
      runtimeStatus: "starting",
      stateRevision: 3
    }),
    workspaceId: "workspace-1"
  });

  const app = controller.store.apps.find(
    (candidate) => candidate.appId === "app-1"
  );
  assert.equal(app?.runtimeStatus, "starting");
  assert.equal(app?.installProgress?.userPhase, "starting");
  assert.equal(app?.installProgress?.overallPercent, 96);
  assert.equal(app?.installProgress?.downloadedBytes, null);

  controller.applyAppUpdate({
    app: createApp({
      appId: "app-1",
      installed: true,
      runtimeStatus: "running",
      stateRevision: 4
    }),
    workspaceId: "workspace-1"
  });
});

test("WorkspaceAppCenterController refreshes a loading catalog while polling", async () => {
  let listCalls = 0;
  const controller = createWorkspaceAppCenterController({
    catalogLoadingRefreshDelayMs: 1,
    formatError,
    gateway: createGateway({
      async listWorkspaceApps() {
        listCalls += 1;
        return createSnapshot();
      }
    })
  });
  controller.beginWorkspacePolling("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ catalogStatus: "loading" })
  );

  await waitFor(() => listCalls === 1);

  assert.equal(controller.store.catalogStatus, "ready");
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController event refresh policy does not start per-app polling", async () => {
  let listCalls = 0;
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway({
      async installWorkspaceApp() {
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installed: false,
              runtimeStatus: "installing",
              stateRevision: 2
            })
          ]
        });
      },
      async listWorkspaceApps() {
        listCalls += 1;
        return createSnapshot();
      }
    }),
    installRefreshDelayMs: 1,
    refreshPolicy: "event"
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ installed: false, runtimeStatus: "idle" })]
    })
  );
  controller.beginWorkspacePolling("workspace-1");

  await controller.installApp({ appId: "app-1", workspaceId: "workspace-1" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(listCalls, 0);
  assert.equal(controller.store.apps[0]?.runtimeStatus, "installing");
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController event refresh policy disables active and transient refresh timers", async () => {
  let listCalls = 0;
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway({
      async listWorkspaceApps() {
        listCalls += 1;
        return createSnapshot();
      }
    }),
    installRefreshDelayMs: 1,
    refreshPolicy: "event",
    transientRuntimeRefreshDelayMs: 1
  });
  controller.beginWorkspacePolling("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          installProgress: {
            downloadedBytes: null,
            indeterminate: true,
            overallPercent: 0,
            totalBytes: null,
            userPhase: "starting"
          },
          runtimeStatus: "starting"
        })
      ]
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(listCalls, 0);
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController orders pushed updates by generation and sequence", () => {
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway(),
    refreshPolicy: "event"
  });
  controller.beginWorkspacePolling("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ runtimeStatus: "idle", stateRevision: 5 })]
    })
  );

  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "starting", stateRevision: 5 }),
    operationCursor: {
      desiredGeneration: 1,
      operationId: "install-1",
      sequence: 2
    },
    workspaceId: "workspace-1"
  });
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "failed", stateRevision: 99 }),
    operationCursor: {
      desiredGeneration: 1,
      operationId: "install-1",
      sequence: 1
    },
    workspaceId: "workspace-1"
  });
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "failed", stateRevision: 100 }),
    operationCursor: {
      desiredGeneration: 1,
      operationId: "different-operation",
      sequence: 99
    },
    workspaceId: "workspace-1"
  });

  assert.equal(controller.store.apps[0]?.runtimeStatus, "starting");

  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "running", stateRevision: 1 }),
    operationCursor: {
      desiredGeneration: 2,
      operationId: "install-2",
      sequence: 0
    },
    workspaceId: "workspace-1"
  });

  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "failed", stateRevision: 100 }),
    operationCursor: {
      desiredGeneration: 3,
      operationId: "install-2",
      sequence: 0
    },
    workspaceId: "workspace-1"
  });
  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController event policy rejects unordered app updates", () => {
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway(),
    refreshPolicy: "event"
  });
  controller.beginWorkspacePolling("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [createApp({ stateRevision: 1 })] })
  );

  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "failed", stateRevision: 100 }),
    workspaceId: "workspace-1"
  });

  assert.equal(controller.store.apps[0]?.runtimeStatus, "idle");
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController fences snapshots after ordered event updates", () => {
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway(),
    refreshPolicy: "event"
  });
  controller.beginWorkspacePolling("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          availableVersion: "1.1.0",
          runtimeStatus: "idle",
          stateRevision: 5
        })
      ]
    })
  );
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "running", stateRevision: 1 }),
    operationCursor: {
      desiredGeneration: 2,
      operationId: "install-2",
      sequence: 2
    },
    workspaceId: "workspace-1"
  });

  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          availableVersion: "1.2.0",
          runtimeStatus: "starting",
          stateRevision: 6
        })
      ]
    })
  );

  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
  assert.equal(controller.store.apps[0]?.stateRevision, 1);
  assert.equal(controller.store.apps[0]?.availableVersion, "1.2.0");

  controller.resetWorkspaceEventCursors("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ runtimeStatus: "starting", stateRevision: 6 })]
    })
  );

  assert.equal(controller.store.apps[0]?.runtimeStatus, "starting");
  assert.equal(controller.store.apps[0]?.stateRevision, 6);
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController backfills launch URL for the running event runtime", () => {
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway(),
    refreshPolicy: "event"
  });
  controller.beginWorkspacePolling("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          installationId: "installation-1",
          runtimeId: "runtime-1",
          runtimeStatus: "starting",
          stateRevision: 5
        })
      ]
    })
  );
  controller.applyAppUpdate({
    app: createApp({
      installationId: "installation-1",
      launchUrl: null,
      runtimeId: "runtime-1",
      runtimeStatus: "running",
      stateRevision: 1
    }),
    operationCursor: {
      desiredGeneration: 2,
      operationId: "install-2",
      sequence: 20
    },
    workspaceId: "workspace-1"
  });

  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          installationId: "installation-1",
          launchUrl: "http://runtime-1.tsh-app.localhost:3000",
          runtimeId: "runtime-1",
          runtimeStatus: "running",
          stateRevision: 6
        })
      ]
    })
  );

  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
  assert.equal(
    controller.store.apps[0]?.launchUrl,
    "http://runtime-1.tsh-app.localhost:3000"
  );
  // Snapshot enrichment must not advance or replace event ordering state.
  assert.equal(controller.store.apps[0]?.stateRevision, 1);

  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          installationId: "installation-1",
          launchUrl: "http://different-runtime.tsh-app.localhost:4000",
          runtimeId: "runtime-2",
          runtimeStatus: "running",
          stateRevision: 7
        })
      ]
    })
  );
  assert.equal(
    controller.store.apps[0]?.launchUrl,
    "http://runtime-1.tsh-app.localhost:3000"
  );
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController clears operation cursors on workspace switch and rejects updates after polling end", () => {
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway(),
    refreshPolicy: "event"
  });
  controller.beginWorkspacePolling("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [createApp({ stateRevision: 5 })] })
  );
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "starting", stateRevision: 1 }),
    operationCursor: {
      desiredGeneration: 2,
      operationId: "workspace-1-operation",
      sequence: 1
    },
    workspaceId: "workspace-1"
  });

  controller.applySnapshot(
    "workspace-2",
    createSnapshot({ apps: [createApp({ stateRevision: 5 })] })
  );
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [createApp({ stateRevision: 5 })] })
  );
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "preparing", stateRevision: 1 }),
    operationCursor: {
      desiredGeneration: 1,
      operationId: "after-switch",
      sequence: 0
    },
    workspaceId: "workspace-1"
  });
  assert.equal(controller.store.apps[0]?.runtimeStatus, "preparing");

  controller.endWorkspacePolling("workspace-1");
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "running", stateRevision: 1 }),
    operationCursor: {
      desiredGeneration: 1,
      operationId: "after-end",
      sequence: 0
    },
    workspaceId: "workspace-1"
  });
  assert.equal(controller.store.apps[0]?.runtimeStatus, "preparing");
});

test("WorkspaceAppCenterController reconnect reset preserves pending install lifecycle", async () => {
  const installedApps: WorkspaceAppCenterApp[] = [];
  const installingApp = createApp({
    installed: false,
    installProgress: {
      downloadedBytes: null,
      indeterminate: true,
      overallPercent: 0,
      totalBytes: null,
      userPhase: "downloading"
    },
    runtimeStatus: "installing",
    stateRevision: 2
  });
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway({
      async installWorkspaceApp() {
        return createSnapshot({ apps: [installingApp] });
      }
    }),
    hooks: {
      onAppInstalled(app) {
        installedApps.push(app);
      }
    },
    refreshPolicy: "event"
  });
  controller.beginWorkspacePolling("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ installed: false, runtimeStatus: "idle" })]
    })
  );

  await controller.installApp({ appId: "app-1", workspaceId: "workspace-1" });
  controller.applyAppUpdate({
    app: createApp({
      installed: false,
      runtimeStatus: "installing",
      stateRevision: 3
    }),
    operationCursor: {
      desiredGeneration: 5,
      operationId: "old-stream-install",
      sequence: 4
    },
    workspaceId: "workspace-1"
  });

  controller.resetWorkspaceEventCursors("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [installingApp] })
  );
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "running", stateRevision: 4 }),
    operationCursor: {
      desiredGeneration: 1,
      operationId: "replacement-stream-install",
      sequence: 0
    },
    workspaceId: "workspace-1"
  });

  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
  assert.equal(installedApps.length, 1);
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController clears cursors before refresh switches workspace", async () => {
  const controller = createWorkspaceAppCenterController({
    formatError,
    gateway: createGateway({
      async listWorkspaceApps() {
        return createSnapshot({ apps: [createApp()] });
      }
    }),
    refreshPolicy: "event"
  });
  controller.beginWorkspacePolling("workspace-1");
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({ apps: [createApp()] })
  );
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "starting" }),
    operationCursor: {
      desiredGeneration: 2,
      operationId: "before-switch",
      sequence: 1
    },
    workspaceId: "workspace-1"
  });

  await controller.refresh("workspace-2");
  await controller.refresh("workspace-1");
  controller.applyAppUpdate({
    app: createApp({ runtimeStatus: "running" }),
    operationCursor: {
      desiredGeneration: 1,
      operationId: "after-switch",
      sequence: 0
    },
    workspaceId: "workspace-1"
  });

  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController clears pending install when backend job disappears", async () => {
  let installCalls = 0;
  const installFailures: unknown[] = [];
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async installWorkspaceApp() {
        installCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installProgress: {
                downloadedBytes: null,
                indeterminate: true,
                overallPercent: 0,
                totalBytes: null,
                userPhase: "downloading"
              },
              installed: false,
              runtimeStatus: "installing",
              stateRevision: installCalls + 1
            })
          ]
        });
      }
    }),
    hooks: {
      onAppInstallFailed(input) {
        installFailures.push(input);
      }
    }
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          installed: false,
          runtimeStatus: "idle"
        })
      ]
    })
  );

  await controller.installApp({
    appId: "app-1",
    workspaceId: "workspace-1"
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          installed: false,
          installProgress: null,
          runtimeStatus: "idle",
          stateRevision: 4
        })
      ]
    })
  );

  assert.equal(controller.store.apps[0]?.runtimeStatus, "idle");
  assert.equal(controller.store.apps[0]?.installProgress, null);
  assert.deepEqual(installFailures, []);

  await controller.installApp({
    appId: "app-1",
    workspaceId: "workspace-1"
  });
  assert.equal(installCalls, 2);

  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          installed: false,
          installProgress: null,
          runtimeStatus: "idle",
          stateRevision: 5
        })
      ]
    })
  );
});

test("WorkspaceAppCenterController preserves pending install progress across catalog refresh", async () => {
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async installWorkspaceApp() {
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              installProgress: {
                downloadedBytes: 1024,
                indeterminate: false,
                overallPercent: 48,
                totalBytes: 4096,
                userPhase: "downloading"
              },
              installed: false,
              runtimeStatus: "installing",
              stateRevision: 2
            })
          ]
        });
      },
      async refreshWorkspaceAppCatalog() {
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              availableVersion: "1.1.0",
              installProgress: null,
              installed: false,
              runtimeStatus: "idle",
              stateRevision: 2,
              updateAvailable: true
            })
          ]
        });
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          installed: false,
          runtimeStatus: "idle"
        })
      ]
    })
  );

  await controller.installApp({
    appId: "app-1",
    workspaceId: "workspace-1"
  });
  await controller.refreshCatalog("workspace-1");

  assert.equal(controller.store.apps[0]?.runtimeStatus, "installing");
  assert.equal(controller.store.apps[0]?.installProgress?.overallPercent, 48);
  assert.equal(controller.store.apps[0]?.availableVersion, "1.1.0");
});

test("WorkspaceAppCenterController only marks idle enabled apps as starting", async () => {
  let optimisticStatuses: string[] = [];
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async startEnabledWorkspaceApps() {
        optimisticStatuses = controller.store.apps.map(
          (app) => app.runtimeStatus
        );
        return createSnapshot({
          apps: [
            createApp({ appId: "app-idle", runtimeStatus: "preparing" }),
            createApp({ appId: "app-failed", runtimeStatus: "failed" }),
            createApp({ appId: "app-stopping", runtimeStatus: "stopping" })
          ]
        });
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({ appId: "app-idle", runtimeStatus: "idle" }),
        createApp({ appId: "app-failed", runtimeStatus: "failed" }),
        createApp({ appId: "app-stopping", runtimeStatus: "stopping" })
      ]
    })
  );

  await controller.startEnabledApps("workspace-1");

  assert.deepEqual(optimisticStatuses, ["preparing", "failed", "stopping"]);
});

test("WorkspaceAppCenterController restarts pending-restart apps before opening", async () => {
  const installInputs: Array<{ restartRunning?: boolean } | undefined> = [];
  const controller = createWorkspaceAppCenterController({
    appOpenLaunchWaitTimeoutMs: 1,
    formatError: formatError,
    gateway: createGateway({
      async installWorkspaceApp(_workspaceId, _appId, input) {
        installInputs.push(input);
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              launchUrl: "http://127.0.0.1:3000",
              runtimeStatus: "running",
              stateRevision: 2,
              version: "1.1.0"
            })
          ]
        });
      }
    })
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [
        createApp({
          appId: "app-1",
          launchUrl: "http://127.0.0.1:3000",
          runtimeStatus: "installed_pending_restart",
          version: "1.1.0"
        })
      ]
    })
  );

  const app = await controller.restartAndOpenApp({
    appId: "app-1",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(installInputs, [{ restartRunning: true }]);
  assert.equal(app?.runtimeStatus, "running");
  assert.equal(app?.launchUrl, "http://127.0.0.1:3000");
});

test("WorkspaceAppCenterController refreshes non-pending active install state", async () => {
  let listCalls = 0;
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async listWorkspaceApps() {
        listCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-idle",
              installProgress: null,
              runtimeStatus: "running",
              stateRevision: 2
            })
          ]
        });
      },
      async startEnabledWorkspaceApps() {
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-idle",
              installProgress: {
                downloadedBytes: null,
                indeterminate: false,
                overallPercent: 96,
                totalBytes: null,
                userPhase: "starting"
              },
              runtimeStatus: "starting",
              stateRevision: 2
            })
          ]
        });
      }
    }),
    installRefreshDelayMs: 1
  });
  controller.applySnapshot(
    "workspace-1",
    createSnapshot({
      apps: [createApp({ appId: "app-idle", runtimeStatus: "idle" })]
    })
  );
  controller.beginWorkspacePolling("workspace-1");

  await controller.startEnabledApps("workspace-1");
  assert.equal(controller.store.apps[0]?.runtimeStatus, "starting");
  assert.equal(controller.store.apps[0]?.installProgress?.overallPercent, 96);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(listCalls, 1);
  assert.equal(controller.store.apps[0]?.runtimeStatus, "running");
  assert.equal(controller.store.apps[0]?.installProgress, null);
  controller.endWorkspacePolling("workspace-1");
});

test("WorkspaceAppCenterController refreshes transient runtime apps after startup", async () => {
  let refreshCalls = 0;
  const controller = createWorkspaceAppCenterController({
    formatError: formatError,
    gateway: createGateway({
      async startEnabledWorkspaceApps() {
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              runtimeStatus: "preparing",
              stateRevision: 2
            })
          ]
        });
      },
      async listWorkspaceApps() {
        refreshCalls += 1;
        return createSnapshot({
          apps: [
            createApp({
              appId: "app-1",
              launchUrl: "http://127.0.0.1:3000",
              runtimeStatus: "running",
              stateRevision: 3
            })
          ]
        });
      }
    }),
    transientRuntimeRefreshDelayMs: 1,
    transientRuntimeRefreshMaxAttempts: 3
  });
  controller.beginWorkspacePolling("workspace-1");
  try {
    controller.applySnapshot(
      "workspace-1",
      createSnapshot({
        apps: [createApp({ appId: "app-1", runtimeStatus: "idle" })]
      })
    );

    await controller.startEnabledApps("workspace-1");
    assert.equal(controller.store.apps[0]?.runtimeStatus, "preparing");

    await waitFor(() => controller.store.apps[0]?.runtimeStatus === "running");

    assert.equal(controller.store.apps[0]?.launchUrl, "http://127.0.0.1:3000");
    assert.equal(refreshCalls, 1);
  } finally {
    controller.endWorkspacePolling("workspace-1");
  }
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

function createSnapshot(
  overrides: Partial<WorkspaceAppCenterSnapshot> = {}
): WorkspaceAppCenterSnapshot {
  return {
    apps: [],
    catalogStatus: "ready",
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

function createFactorySnapshot(
  overrides: Partial<WorkspaceAppFactorySnapshot> = {}
): WorkspaceAppFactorySnapshot {
  return {
    jobs: [],
    ...overrides
  };
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
    async fixWorkspaceAppFactoryJob() {
      return createFactorySnapshot();
    },
    async prepareWorkspaceAppFactoryJobModification() {
      return createFactorySnapshot();
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "error";
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail("condition was not reached before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
