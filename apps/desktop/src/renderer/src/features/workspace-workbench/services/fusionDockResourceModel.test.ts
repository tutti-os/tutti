import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceAgentSession,
  WorkspaceApp,
  WorkspaceTerminalSession
} from "@tutti-os/client-tuttid-ts";
import type { DesktopFusionWindowDescriptor } from "@shared/contracts/fusion.ts";
import { projectFusionBackgroundResources } from "./fusionDockResourceModel.ts";

test("Fusion Dock joins durable tasks with native windows without hiding detached work", () => {
  const resources = projectFusionBackgroundResources({
    agentSessions: [createAgentSession()],
    apps: [createApp()],
    terminals: [createTerminal()],
    windows: [createWindow("agent", "agent-1")],
    workspaceId: "workspace-1",
    workspaceName: "Workspace One"
  });

  assert.deepEqual(
    resources.map((resource) => ({
      attachedWindowCount: resource.attachedWindowCount,
      canStop: resource.canStop,
      category: resource.category,
      id: resource.id,
      kind: resource.kind
    })),
    [
      {
        attachedWindowCount: 0,
        canStop: true,
        category: "background-task",
        id: "app-1",
        kind: "workspace-app"
      },
      {
        attachedWindowCount: 0,
        canStop: true,
        category: "background-task",
        id: "terminal-1",
        kind: "terminal"
      },
      {
        attachedWindowCount: 1,
        canStop: true,
        category: "background-task",
        id: "agent-1",
        kind: "agent"
      }
    ]
  );
});

test("completed resumable Agent sessions remain reconnectable but cannot be stopped", () => {
  const resources = projectFusionBackgroundResources({
    agentSessions: [
      { ...createAgentSession(), resumable: true, status: "completed" }
    ],
    apps: [],
    terminals: [],
    windows: [],
    workspaceId: "workspace-1",
    workspaceName: "Workspace One"
  });

  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.canStop, false);
  assert.equal(resources[0]?.category, "recoverable-session");
  assert.equal(resources[0]?.provider, "codex");
});

test("resource attachment identity includes workspace id", () => {
  const window = createWindow("workspace-app", "app-1");
  const first = projectFusionBackgroundResources({
    agentSessions: [],
    apps: [createApp()],
    terminals: [],
    windows: [window],
    workspaceId: "workspace-1",
    workspaceName: "Workspace One"
  });
  const second = projectFusionBackgroundResources({
    agentSessions: [],
    apps: [createApp()],
    terminals: [],
    windows: [window],
    workspaceId: "workspace-2",
    workspaceName: "Workspace Two"
  });

  assert.equal(first[0]?.attachedWindowCount, 1);
  assert.equal(second[0]?.attachedWindowCount, 0);
});

test("Workspace App resources include live runtimes but exclude failed state", () => {
  const resources = projectFusionBackgroundResources({
    agentSessions: [],
    apps: [
      { ...createApp(), appId: "failed", status: "failed" },
      {
        ...createApp(),
        appId: "pending-restart",
        status: "installed_pending_restart"
      },
      { ...createApp(), appId: "stopping", status: "stopping" }
    ],
    terminals: [],
    windows: [],
    workspaceId: "workspace-1",
    workspaceName: "Workspace One"
  });

  assert.deepEqual(
    resources.map((resource) => ({
      canStop: resource.canStop,
      id: resource.id
    })),
    [
      { canStop: true, id: "pending-restart" },
      { canStop: false, id: "stopping" }
    ]
  );
});

function createAgentSession(): WorkspaceAgentSession {
  return {
    createdAt: "2026-07-12T00:00:00.000Z",
    cwd: "/workspace",
    id: "agent-1",
    provider: "codex",
    status: "running",
    title: "Implement Fusion",
    updatedAt: "2026-07-12T00:00:01.000Z",
    visible: true
  };
}

function createTerminal(): WorkspaceTerminalSession {
  return {
    cols: 80,
    createdAt: "2026-07-12T00:00:00.000Z",
    cwd: "/workspace",
    endedAt: null,
    id: "terminal-1",
    lastError: null,
    profileId: null,
    rows: 24,
    runtimeKind: "local",
    status: "detached",
    title: "Dev server",
    updatedAt: "2026-07-12T00:00:02.000Z",
    workspaceId: "workspace-1"
  };
}

function createApp(): WorkspaceApp {
  return {
    appId: "app-1",
    authors: [],
    availableIconUrl: null,
    availableVersion: null,
    cli: { active: false, issues: [], status: "none" },
    createdAtUnixMs: 1,
    description: "",
    displayName: "App One",
    enabled: true,
    exportable: false,
    failureReason: null,
    iconUrl: null,
    installed: true,
    lastError: null,
    launchUrl: "http://127.0.0.1:4000",
    localizations: [],
    minimizeBehavior: "hibernate",
    port: 4000,
    references: { listSupported: false, searchSupported: false },
    source: "builtin",
    startedAtUnixMs: 2,
    stateRevision: 1,
    status: "running",
    tags: [],
    updateAvailable: false,
    updatedAtUnixMs: Date.parse("2026-07-12T00:00:03.000Z"),
    version: "1.0.0",
    windowMinHeight: null,
    windowMinWidth: null
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
    windowInstanceId: "window-1",
    workspaceId: "workspace-1"
  };
}
