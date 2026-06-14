import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterGateway,
  WorkspaceAppCenterSnapshot,
  WorkspaceAppFactoryJob,
  WorkspaceAppFactorySnapshot
} from "../contracts/host.ts";
import { createWorkspaceAppCenterController } from "./index.ts";

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
