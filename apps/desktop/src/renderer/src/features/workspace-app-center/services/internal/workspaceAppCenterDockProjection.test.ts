import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceAppCenterDockOrder,
  workspaceAppDockOrderStart
} from "./workspaceAppCenterDockOrdering.ts";
import { projectWorkspaceAppCenterDockApps } from "./workspaceAppCenterDockProjection.ts";
import { workspaceAppCenterFrame } from "./workspaceAppCenterFrame.ts";

test("workspace app center dock order stays before task and app entries", () => {
  assert.ok(workspaceAppCenterDockOrder < 0);
  assert.ok(workspaceAppCenterDockOrder < workspaceAppDockOrderStart);
});

test("workspace app center opens at the shared dialog-sized frame", () => {
  assert.deepEqual(workspaceAppCenterFrame, {
    height: 620,
    width: 1040,
    x: 140,
    y: 48
  });
});

test("projectWorkspaceAppCenterDockApps maps runtime status to dock state", () => {
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: "https://app.local",
      runtimeStatus: "running"
    }),
    {
      app: createApp({
        launchUrl: "https://app.local",
        runtimeStatus: "running"
      }),
      launchEnabled: true,
      state: { kind: "enabled" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: null,
      runtimeStatus: "installed_pending_restart"
    }),
    {
      app: createApp({
        launchUrl: null,
        runtimeStatus: "installed_pending_restart"
      }),
      clickBehavior: "launch",
      launchEnabled: true,
      state: { kind: "enabled" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: "https://app.local",
      runtimeStatus: "starting"
    }),
    {
      app: createApp({
        launchUrl: "https://app.local",
        runtimeStatus: "starting"
      }),
      launchEnabled: false,
      state: { kind: "loading" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: "https://app.local",
      runtimeStatus: "preparing"
    }),
    {
      app: createApp({
        launchUrl: "https://app.local",
        runtimeStatus: "preparing"
      }),
      launchEnabled: false,
      state: { kind: "loading" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: "https://app.local",
      runtimeStatus: "installing"
    }),
    {
      app: createApp({
        launchUrl: "https://app.local",
        runtimeStatus: "installing"
      }),
      launchEnabled: false,
      state: { kind: "loading" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: "https://app.local",
      runtimeStatus: "failed"
    }),
    {
      app: createApp({
        launchUrl: "https://app.local",
        runtimeStatus: "failed"
      }),
      launchEnabled: false,
      state: { kind: "unavailable" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: null,
      runtimeStatus: "failed"
    }),
    {
      app: createApp({
        launchUrl: null,
        runtimeStatus: "failed"
      }),
      launchEnabled: false,
      state: { kind: "unavailable" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: "https://app.local",
      runtimeStatus: "unavailable"
    }),
    {
      app: createApp({
        launchUrl: "https://app.local",
        runtimeStatus: "unavailable"
      }),
      launchEnabled: false,
      state: { kind: "unavailable" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: "https://app.local",
      runtimeStatus: "idle"
    }),
    {
      app: createApp({
        launchUrl: "https://app.local",
        runtimeStatus: "idle"
      }),
      launchEnabled: true,
      state: { kind: "enabled" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      installed: false,
      launchUrl: "https://app.local",
      runtimeStatus: "idle"
    }),
    {
      app: createApp({
        installed: false,
        launchUrl: "https://app.local",
        runtimeStatus: "idle"
      }),
      launchEnabled: false,
      state: { kind: "disabled" }
    }
  );
  assert.deepEqual(
    projectSingleWorkspaceAppCenterDockApp({
      launchUrl: null,
      runtimeStatus: "running"
    }),
    {
      app: createApp({
        launchUrl: null,
        runtimeStatus: "running"
      }),
      launchEnabled: false,
      state: {
        kind: "disabled",
        reason: "missing-url"
      }
    }
  );
});

test("projectWorkspaceAppCenterDockApps includes only enabled apps", () => {
  const projections = projectWorkspaceAppCenterDockApps([
    {
      appId: "notes",
      createdAtUnixMs: 1,
      enabled: true,
      exportable: false,
      installed: true,
      minimizeBehavior: "keep-mounted",
      name: "Notes",
      references: { listSupported: false },
      runtimeStatus: "running",
      source: "builtin",
      stateRevision: 1,
      launchUrl: "https://notes.local"
    },
    {
      appId: "disabled",
      createdAtUnixMs: 1,
      enabled: false,
      exportable: false,
      installed: true,
      minimizeBehavior: "keep-mounted",
      name: "Disabled",
      references: { listSupported: false },
      runtimeStatus: "idle",
      source: "builtin",
      stateRevision: 1,
      launchUrl: "https://disabled.local"
    },
    {
      appId: "not-installed",
      createdAtUnixMs: 1,
      enabled: true,
      exportable: false,
      installed: false,
      minimizeBehavior: "keep-mounted",
      name: "Not installed",
      references: { listSupported: false },
      runtimeStatus: "idle",
      source: "builtin",
      stateRevision: 1,
      launchUrl: "https://not-installed.local"
    }
  ]);

  assert.equal(projections.length, 2);
  assert.equal(projections[0]?.app.appId, "notes");
  assert.equal(projections[0]?.launchEnabled, true);
  assert.equal(projections[1]?.app.appId, "not-installed");
  assert.equal(projections[1]?.launchEnabled, false);
  assert.deepEqual(projections[1]?.state, { kind: "disabled" });
});

function projectSingleWorkspaceAppCenterDockApp(
  input: Partial<ReturnType<typeof createApp>>
) {
  return projectWorkspaceAppCenterDockApps([createApp(input)])[0] ?? null;
}

function createApp(
  input: Partial<{
    appId: string;
    createdAtUnixMs: number;
    enabled: boolean;
    exportable: boolean;
    installed: boolean;
    launchUrl: string | null;
    minimizeBehavior: "keep-mounted";
    name: string;
    references: { listSupported: boolean };
    runtimeStatus:
      | "idle"
      | "installing"
      | "installed_pending_restart"
      | "running"
      | "preparing"
      | "starting"
      | "stopping"
      | "failed"
      | "unavailable";
    source: "builtin";
    stateRevision: number;
  }> = {}
) {
  return {
    appId: "notes",
    createdAtUnixMs: 1,
    enabled: true,
    exportable: false,
    installed: true,
    launchUrl: "https://app.local",
    minimizeBehavior: "keep-mounted" as const,
    name: "Notes",
    references: { listSupported: false },
    runtimeStatus: "idle" as const,
    source: "builtin" as const,
    stateRevision: 1,
    ...input
  };
}
