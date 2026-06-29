import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceAppCenterDockOrder,
  workspaceAppDockOrderStart
} from "./workspaceAppCenterDockOrdering.ts";
import {
  projectWorkspaceAppCenterDockApps,
  projectWorkspaceAppCenterDockState
} from "./workspaceAppCenterDockProjection.ts";
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

test("projectWorkspaceAppCenterDockState maps runtime status to dock state", () => {
  assert.deepEqual(
    projectWorkspaceAppCenterDockState("running", "https://app.local"),
    {
      launchEnabled: true,
      state: { kind: "enabled" }
    }
  );
  assert.deepEqual(
    projectWorkspaceAppCenterDockState("installed_pending_restart", null),
    {
      clickBehavior: "launch",
      launchEnabled: true,
      state: { kind: "enabled" }
    }
  );
  assert.deepEqual(
    projectWorkspaceAppCenterDockState("starting", "https://app.local"),
    {
      launchEnabled: false,
      state: { kind: "loading" }
    }
  );
  assert.deepEqual(
    projectWorkspaceAppCenterDockState("preparing", "https://app.local"),
    {
      launchEnabled: false,
      state: { kind: "loading" }
    }
  );
  assert.deepEqual(
    projectWorkspaceAppCenterDockState("installing", "https://app.local"),
    {
      launchEnabled: false,
      state: { kind: "loading" }
    }
  );
  assert.deepEqual(
    projectWorkspaceAppCenterDockState("failed", "https://app.local"),
    {
      launchEnabled: false,
      state: { kind: "unavailable" }
    }
  );
  assert.deepEqual(projectWorkspaceAppCenterDockState("failed", null), {
    launchEnabled: false,
    state: { kind: "unavailable" }
  });
  assert.deepEqual(
    projectWorkspaceAppCenterDockState("unavailable", "https://app.local"),
    {
      launchEnabled: false,
      state: { kind: "unavailable" }
    }
  );
  assert.deepEqual(
    projectWorkspaceAppCenterDockState("idle", "https://app.local"),
    {
      launchEnabled: true,
      state: { kind: "enabled" }
    }
  );
  assert.deepEqual(
    projectWorkspaceAppCenterDockState("idle", "https://app.local", false),
    {
      launchEnabled: false,
      state: { kind: "disabled" }
    }
  );
  assert.deepEqual(projectWorkspaceAppCenterDockState("running", null), {
    launchEnabled: false,
    state: {
      kind: "disabled",
      reason: "missing-url"
    }
  });
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
