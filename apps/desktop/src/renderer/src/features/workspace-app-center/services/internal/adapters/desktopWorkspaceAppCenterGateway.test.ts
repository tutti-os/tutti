import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceApp,
  WorkspaceAppListResponse
} from "@tutti-os/client-tuttid-ts";
import {
  normalizeWorkspaceAppCenterApp,
  normalizeWorkspaceAppCenterSnapshot,
  type WorkspaceAppLike
} from "./desktopWorkspaceAppCenterGateway.ts";

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
