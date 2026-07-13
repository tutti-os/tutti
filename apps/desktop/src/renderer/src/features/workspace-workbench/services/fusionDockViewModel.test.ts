import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopFusionWindowDescriptor } from "@shared/contracts/fusion.ts";
import type { TranslateFn } from "@renderer/i18n";
import type { WorkbenchHostDockEntry } from "@tutti-os/workbench-surface";
import type { FusionBackgroundResource } from "./fusionDockResourceModel.ts";
import type { FusionDockLauncher } from "./fusionDockLauncherModel.ts";
import {
  createFusionSearchItems,
  resolveFusionSearchEnterAction,
  shouldShowFusionWorkspaceContext
} from "./fusionDockViewModel.ts";

test("Fusion Dock search includes workspace names and workspace-scoped resource ids", () => {
  const resources = [
    createResource("workspace-1", "Alpha"),
    createResource("workspace-2", "Beta")
  ];
  const results = createFusionSearchItems({
    launchers: [createLauncher("browser", "browser")],
    query: "beta",
    resources,
    settingsLabel: "Settings",
    t: ((key: string) => key) as TranslateFn,
    windows: [],
    workspaceNameById: {}
  });

  assert.deepEqual(
    results.map((item) => item.id),
    ["resource:workspace-2:workspace-app:app-1"]
  );
});

test("Fusion Dock empty search stays command-oriented instead of listing every window and task", () => {
  const results = createFusionSearchItems({
    launchers: [createLauncher("browser", "browser")],
    query: "",
    resources: [createResource("workspace-2", "Beta")],
    settingsLabel: "Settings",
    t: ((key: string) => key) as TranslateFn,
    windows: [createWindow("browser", "browser-1")],
    workspaceNameById: {}
  });

  assert.deepEqual(
    results.map((item) => item.id),
    ["launcher:browser", "command:settings"]
  );
});

test("Fusion Dock background-task scope never mixes launchers or native windows into results", () => {
  const common = {
    launchers: [createLauncher("browser", "browser")],
    resources: [
      createResource("workspace-2", "Beta"),
      createRecoverableAgentResource()
    ],
    scope: "background-tasks" as const,
    settingsLabel: "Settings",
    t: ((key: string) =>
      key === "workspace.fusion.recoverableSession"
        ? "Recoverable session"
        : key) as TranslateFn,
    windows: [createWindow("browser", "browser-1")],
    workspaceNameById: {}
  };

  assert.deepEqual(
    createFusionSearchItems({ ...common, query: "" }).map((item) => item.id),
    ["resource:workspace-2:workspace-app:app-1"]
  );
  assert.deepEqual(
    createFusionSearchItems({ ...common, query: "beta" }).map(
      (item) => item.id
    ),
    ["resource:workspace-2:workspace-app:app-1"]
  );
  assert.deepEqual(
    createFusionSearchItems({ ...common, query: "browser" }),
    []
  );
  assert.deepEqual(
    createFusionSearchItems({ ...common, query: "recoverable" }),
    []
  );
  assert.deepEqual(
    createFusionSearchItems({
      ...common,
      query: "recoverable",
      scope: "all"
    }).map((item) => item.id),
    ["resource:workspace-2:agent:agent-completed"]
  );
});

test("Fusion Dock Command or Control Enter selects explicit new-window action", () => {
  assert.equal(
    resolveFusionSearchEnterAction({ ctrlKey: false, metaKey: false }),
    "activate"
  );
  assert.equal(
    resolveFusionSearchEnterAction({ ctrlKey: false, metaKey: true }),
    "new"
  );
  assert.equal(
    resolveFusionSearchEnterAction({ ctrlKey: true, metaKey: false }),
    "new"
  );
});

test("Fusion Dock only surfaces workspace context for mixed-workspace rows", () => {
  assert.equal(
    shouldShowFusionWorkspaceContext({
      resources: [createResource("workspace-1", "Alpha")],
      windows: [createWindow("browser", "browser-1")]
    }),
    false
  );
  assert.equal(
    shouldShowFusionWorkspaceContext({
      resources: [createResource("workspace-2", "Beta")],
      windows: [createWindow("browser", "browser-1")]
    }),
    true
  );
  assert.equal(
    shouldShowFusionWorkspaceContext({
      currentWorkspaceId: "workspace-1",
      resources: [createResource("workspace-2", "Beta")],
      windows: []
    }),
    true
  );
});

function createResource(
  workspaceId: string,
  workspaceName: string
): FusionBackgroundResource {
  return {
    attachedWindowCount: 0,
    canStop: true,
    category: "background-task",
    id: "app-1",
    kind: "workspace-app",
    provider: null,
    status: "running",
    subtitle: "1.0.0",
    title: "App One",
    updatedAtUnixMs: 1,
    workspaceId,
    workspaceName
  };
}

function createRecoverableAgentResource(): FusionBackgroundResource {
  return {
    attachedWindowCount: 0,
    canStop: false,
    category: "recoverable-session",
    id: "agent-completed",
    kind: "agent",
    provider: "codex",
    status: "completed",
    subtitle: null,
    title: "Finished Agent",
    updatedAtUnixMs: 2,
    workspaceId: "workspace-2",
    workspaceName: "Beta"
  };
}

function createWindow(
  kind: DesktopFusionWindowDescriptor["kind"],
  resourceId: string
): DesktopFusionWindowDescriptor {
  return {
    createdAtUnixMs: 1,
    focused: false,
    kind,
    lastFocusedAtUnixMs: 1,
    resourceId,
    title: null,
    visibility: "visible",
    windowInstanceId: `${kind}-window`,
    workspaceId: "workspace-1"
  };
}

function createLauncher(
  id: string,
  kind: FusionDockLauncher["kind"]
): FusionDockLauncher {
  return {
    entry: {
      icon: null,
      id,
      label: id,
      typeId: kind
    } satisfies WorkbenchHostDockEntry,
    kind,
    resourceId: null,
    workspaceId: "workspace-1"
  };
}
