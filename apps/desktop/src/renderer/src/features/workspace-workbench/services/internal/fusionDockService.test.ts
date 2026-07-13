import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopFusionApi } from "@preload/types";
import type { WorkspaceTerminalSession } from "@tutti-os/client-tuttid-ts";
import type {
  DesktopFusionOpenWindowInput,
  DesktopFusionState,
  DesktopFusionWindowDescriptor
} from "@shared/contracts/fusion.ts";
import type { FusionDockResourceClient } from "../fusionDockService.interface.ts";
import type { FusionBackgroundResource } from "../fusionDockResourceModel.ts";
import {
  FusionDockService,
  type FusionDockServiceScheduler
} from "./fusionDockService.ts";

test("FusionDockService waits for authoritative native state before polling", async () => {
  const authoritativeState = createDeferred<DesktopFusionState>();
  let discoveryCount = 0;
  let intervalCount = 0;
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      getState() {
        return authoritativeState.promise;
      }
    }),
    resourceClient: createResourceClient({
      async listWorkspaces() {
        discoveryCount += 1;
        return createWorkspaceList();
      }
    }),
    scheduler: {
      clearInterval() {},
      setInterval() {
        intervalCount += 1;
        return intervalCount;
      }
    },
    workspaceId: "workspace-1"
  });

  const started = service.start();
  await Promise.resolve();
  assert.equal(service.store.fusionState.dockVisible, false);
  assert.equal(discoveryCount, 0);
  assert.equal(intervalCount, 0);

  authoritativeState.resolve(createFusionState());
  await started;
  assert.equal(discoveryCount, 1);
  assert.equal(intervalCount, 1);
  service.dispose();
});

test("FusionDockService owns and disposes its native-state subscription and polling timer", async () => {
  const stateListeners: Array<(state: DesktopFusionState) => void> = [];
  let unsubscribeCount = 0;
  const clearedHandles: unknown[] = [];
  const intervalHandle = { kind: "fusion-resource-poll" };
  const scheduler: FusionDockServiceScheduler = {
    clearInterval(handle) {
      clearedHandles.push(handle);
    },
    setInterval(_callback, delayMs) {
      assert.equal(delayMs, 5_000);
      return intervalHandle;
    }
  };
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      onState(listener) {
        stateListeners.push(listener);
        return () => {
          unsubscribeCount += 1;
        };
      }
    }),
    resourceClient: createResourceClient(),
    scheduler,
    workspaceId: "workspace-1"
  });

  await service.start();
  assert.equal(stateListeners.length, 1);
  assert.equal(service.store.fusionState.revision, 1);

  service.dispose();
  service.dispose();
  assert.equal(unsubscribeCount, 1);
  assert.deepEqual(clearedHandles, [intervalHandle]);

  stateListeners[0]?.({
    ...createFusionState(),
    dockVisible: false,
    revision: 99
  });
  assert.equal(service.store.fusionState.revision, 1);
});

test("FusionDockService queues a full discovery when hide and show race an in-flight poll", async () => {
  const stateListeners: Array<(state: DesktopFusionState) => void> = [];
  const firstDiscovery =
    createDeferred<ReturnType<typeof createWorkspaceList>>();
  let discoveryCount = 0;
  let nextIntervalHandle = 0;
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      onState(listener) {
        stateListeners.push(listener);
        return () => undefined;
      }
    }),
    resourceClient: createResourceClient({
      listWorkspaces() {
        discoveryCount += 1;
        return discoveryCount === 1
          ? firstDiscovery.promise
          : Promise.resolve(createWorkspaceList());
      }
    }),
    scheduler: {
      clearInterval() {},
      setInterval() {
        nextIntervalHandle += 1;
        return nextIntervalHandle;
      }
    },
    workspaceId: "workspace-1"
  });

  await service.start();
  assert.equal(discoveryCount, 1);
  stateListeners[0]?.({
    ...createFusionState(),
    dockVisible: false,
    revision: 2
  });
  stateListeners[0]?.({
    ...createFusionState(),
    dockVisible: true,
    revision: 3
  });
  assert.equal(discoveryCount, 1);

  firstDiscovery.resolve(createWorkspaceList());
  await waitFor(() => discoveryCount === 2);
  assert.equal(service.store.fusionState.dockVisible, true);
  assert.equal(discoveryCount, 2);
  service.dispose();
});

test("FusionDockService keeps terminal confirmation and stop ownership in the service", async () => {
  const terminated: string[][] = [];
  const service = new FusionDockService({
    fusionApi: createFusionApi(),
    resourceClient: createResourceClient({
      async checkWorkspaceTerminalCloseGuard(workspaceId, terminalId) {
        assert.deepEqual(
          [workspaceId, terminalId],
          ["workspace-2", "terminal-1"]
        );
        return {
          leaderCommand: "  pnpm dev  ",
          requiresConfirmation: true
        } as never;
      },
      async terminateWorkspaceTerminal(workspaceId, terminalId) {
        terminated.push([workspaceId, terminalId]);
        return {} as never;
      }
    }),
    workspaceId: "workspace-1"
  });
  const resource = createTerminalResource();

  await service.stopResource(resource);
  assert.equal(service.store.pendingTerminalStop?.details, "pnpm dev");
  assert.equal(
    service.store.pendingTerminalStop?.resource.workspaceId,
    "workspace-2"
  );
  assert.deepEqual(terminated, []);

  await service.confirmPendingTerminalStop();
  assert.equal(service.store.pendingTerminalStop, null);
  assert.deepEqual(terminated, [["workspace-2", "terminal-1"]]);
  service.dispose();
});

test("FusionDockService ignores a pending stop result after disposal", async () => {
  const closeGuard = createDeferred<{
    leaderCommand: string;
    requiresConfirmation: boolean;
  }>();
  let discoveryCount = 0;
  const service = new FusionDockService({
    fusionApi: createFusionApi(),
    resourceClient: createResourceClient({
      checkWorkspaceTerminalCloseGuard() {
        return closeGuard.promise as never;
      },
      async listWorkspaces() {
        discoveryCount += 1;
        return createWorkspaceList();
      }
    }),
    workspaceId: "workspace-1"
  });

  const stopping = service.stopResource(createTerminalResource());
  service.dispose();
  closeGuard.resolve({
    leaderCommand: "pnpm dev",
    requiresConfirmation: true
  });
  await stopping;

  assert.equal(service.store.pendingTerminalStop, null);
  assert.equal(service.store.actionError, false);
  assert.equal(service.store.refreshing, false);
  assert.equal(discoveryCount, 0);
});

test("FusionDockService does not refresh after a stopped action resolves post-disposal", async () => {
  const closeGuard = createDeferred<{
    leaderCommand: null;
    requiresConfirmation: boolean;
  }>();
  let discoveryCount = 0;
  const service = new FusionDockService({
    fusionApi: createFusionApi(),
    resourceClient: createResourceClient({
      checkWorkspaceTerminalCloseGuard() {
        return closeGuard.promise as never;
      },
      async listWorkspaces() {
        discoveryCount += 1;
        return createWorkspaceList();
      }
    }),
    workspaceId: "workspace-1"
  });

  const stopping = service.stopResource(createTerminalResource());
  service.dispose();
  closeGuard.resolve({ leaderCommand: null, requiresConfirmation: false });
  await stopping;

  assert.equal(service.store.refreshing, false);
  assert.equal(discoveryCount, 0);
});

test("FusionDockService ignores an action rejection after disposal", async () => {
  const focus = createDeferred<void>();
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      focusWindow() {
        return focus.promise;
      }
    }),
    resourceClient: createResourceClient(),
    workspaceId: "workspace-1"
  });

  const focusing = service.focusWindow("window-1");
  service.dispose();
  focus.reject(new Error("window unavailable"));
  await focusing;
  assert.equal(service.store.actionError, false);
});

test("FusionDockService delegates normal and explicit launcher opens without family matching", async () => {
  const opened: DesktopFusionOpenWindowInput[] = [];
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      async openWindow(input) {
        opened.push(input);
        return createWindowDescriptor(input);
      }
    }),
    resourceClient: createResourceClient(),
    workspaceId: "workspace-1"
  });
  const launcher = {
    kind: "workspace-app" as const,
    launchPayload: { appId: "notes" },
    resourceId: "notes",
    title: "Notes",
    workspaceId: "workspace-1"
  };

  await service.activateLauncher(launcher);
  await service.openLauncherInNewWindow(launcher);

  assert.deepEqual(
    opened.map((request) => request.forceNew),
    [false, true]
  );
  assert.deepEqual(
    opened.map((request) => request.resourceId),
    ["notes", "notes"]
  );
  service.dispose();
});

test("FusionDockService normal generic activation focuses MRU then reconnects newest background work", async () => {
  const focused: string[] = [];
  const opened: DesktopFusionOpenWindowInput[] = [];
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      async focusWindow(input) {
        focused.push(input.windowInstanceId);
      },
      async openWindow(input) {
        opened.push(input);
        return createWindowDescriptor(input);
      }
    }),
    resourceClient: createResourceClient(),
    workspaceId: "workspace-1"
  });
  service.store.fusionState = {
    ...createFusionState(),
    windows: [
      {
        createdAtUnixMs: 1,
        focused: false,
        kind: "terminal",
        lastFocusedAtUnixMs: 20,
        resourceId: "terminal-mru",
        title: "MRU",
        visibility: "minimized",
        windowInstanceId: "window-mru",
        workspaceId: "workspace-1"
      }
    ]
  };
  service.store.resources = [
    createTerminalResource({
      id: "terminal-old",
      updatedAtUnixMs: 10,
      workspaceId: "workspace-1"
    }),
    createTerminalResource({
      id: "terminal-new",
      updatedAtUnixMs: 30,
      workspaceId: "workspace-1"
    })
  ];

  await service.activateLauncher({
    kind: "terminal",
    workspaceId: "workspace-1"
  });
  assert.deepEqual(focused, ["window-mru"]);
  assert.deepEqual(opened, []);

  service.store.fusionState = {
    ...service.store.fusionState,
    revision: 2,
    windows: []
  };
  await service.activateLauncher({
    kind: "terminal",
    workspaceId: "workspace-1"
  });
  assert.deepEqual(opened, [
    {
      forceNew: false,
      kind: "terminal",
      launchPayload: { sessionId: "terminal-new" },
      resourceId: "terminal-new",
      title: "Terminal",
      workspaceId: "workspace-1"
    }
  ]);
  service.dispose();
});

test("FusionDockService waits for the current resource discovery before a launcher creates new work", async () => {
  const terminalList = createDeferred<{
    terminals: WorkspaceTerminalSession[];
  }>();
  const opened: DesktopFusionOpenWindowInput[] = [];
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      async openWindow(input) {
        opened.push(input);
        return createWindowDescriptor(input);
      }
    }),
    resourceClient: createResourceClient({
      listWorkspaceTerminals() {
        return terminalList.promise as never;
      }
    }),
    workspaceId: "workspace-1"
  });

  await service.start();
  const activating = service.activateLauncher({
    kind: "terminal",
    workspaceId: "workspace-1"
  });
  await Promise.resolve();
  assert.deepEqual(opened, []);

  terminalList.resolve({
    terminals: [createWorkspaceTerminalSession("terminal-existing")]
  });
  await activating;

  assert.deepEqual(opened, [
    {
      forceNew: false,
      kind: "terminal",
      launchPayload: { sessionId: "terminal-existing" },
      resourceId: "terminal-existing",
      title: "Existing terminal",
      workspaceId: "workspace-1"
    }
  ]);
  service.dispose();
});

test("FusionDockService waits for the full refresh after a hidden Dock is shown", async () => {
  const stateListeners: Array<(state: DesktopFusionState) => void> = [];
  const refreshedTerminals = createDeferred<{
    terminals: WorkspaceTerminalSession[];
  }>();
  const opened: DesktopFusionOpenWindowInput[] = [];
  let terminalRefreshCount = 0;
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      onState(listener) {
        stateListeners.push(listener);
        return () => undefined;
      },
      async openWindow(input) {
        opened.push(input);
        return createWindowDescriptor(input);
      }
    }),
    resourceClient: createResourceClient({
      listWorkspaceTerminals() {
        terminalRefreshCount += 1;
        return terminalRefreshCount === 1
          ? Promise.resolve({ terminals: [] } as never)
          : (refreshedTerminals.promise as never);
      }
    }),
    workspaceId: "workspace-1"
  });

  await service.start();
  await waitFor(() => terminalRefreshCount === 1 && !service.store.refreshing);
  stateListeners[0]?.({
    ...createFusionState(),
    dockVisible: false,
    revision: 2
  });
  stateListeners[0]?.({
    ...createFusionState(),
    dockVisible: true,
    revision: 3
  });
  await waitFor(() => terminalRefreshCount === 2);

  const activating = service.activateLauncher({
    kind: "terminal",
    workspaceId: "workspace-1"
  });
  await Promise.resolve();
  assert.deepEqual(opened, []);

  refreshedTerminals.resolve({
    terminals: [createWorkspaceTerminalSession("terminal-after-hide")]
  });
  await activating;

  assert.deepEqual(opened, [
    {
      forceNew: false,
      kind: "terminal",
      launchPayload: { sessionId: "terminal-after-hide" },
      resourceId: "terminal-after-hide",
      title: "Existing terminal",
      workspaceId: "workspace-1"
    }
  ]);
  service.dispose();
});

test("FusionDockService search reconnect uses normal activation while explicit resource New Window stays forced", async () => {
  const opened: DesktopFusionOpenWindowInput[] = [];
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      async openWindow(input) {
        opened.push(input);
        return createWindowDescriptor(input);
      }
    }),
    resourceClient: createResourceClient(),
    workspaceId: "workspace-1"
  });
  const resource = createTerminalResource({
    id: "terminal-search",
    workspaceId: "workspace-1"
  });
  service.store.resources = [resource];

  await service.focusOrReconnectResource(resource);
  await service.openResourceInNewWindow(resource);

  assert.deepEqual(
    opened.map((request) => request.forceNew),
    [false, true]
  );
  assert.deepEqual(
    opened.map((request) => request.resourceId),
    ["terminal-search", "terminal-search"]
  );
  service.dispose();
});

test("FusionDockService duplicates a composite Agent resource with its owning workspace provider", async () => {
  const opened: DesktopFusionOpenWindowInput[] = [];
  const service = new FusionDockService({
    fusionApi: createFusionApi({
      async openWindow(input) {
        opened.push(input);
        return createWindowDescriptor(input);
      }
    }),
    resourceClient: createResourceClient(),
    workspaceId: "workspace-1"
  });
  const target = createAgentResource("workspace-2", "claude-code");
  service.store.resources = [
    createAgentResource("workspace-1", "codex"),
    target
  ];

  await service.openWindowInNewWindow({
    createdAtUnixMs: 1,
    focused: true,
    kind: "agent",
    lastFocusedAtUnixMs: 2,
    resourceId: target.id,
    title: target.title,
    visibility: "visible",
    windowInstanceId: "window-2",
    workspaceId: target.workspaceId
  });

  assert.deepEqual(opened, [
    {
      forceNew: true,
      kind: "agent",
      launchPayload: {
        agentSessionId: "agent-session-1",
        provider: "claude-code"
      },
      resourceId: "agent-session-1",
      title: "Agent",
      workspaceId: "workspace-2"
    }
  ]);
  service.dispose();
});

function createFusionApi(
  overrides: Partial<DesktopFusionApi> = {}
): DesktopFusionApi {
  return {
    async closeWindow() {},
    async focusWindow() {},
    async getState() {
      return createFusionState();
    },
    async hideDock() {},
    async openWindow(input) {
      return createWindowDescriptor(input);
    },
    onState() {
      return () => undefined;
    },
    async showDock() {},
    async toggleDock() {},
    async updateWindow(input) {
      return {
        ...createWindowDescriptor({
          kind: "settings",
          workspaceId: "workspace-1"
        }),
        windowInstanceId: input.windowInstanceId
      };
    },
    ...overrides
  };
}

function createFusionState(): DesktopFusionState {
  return {
    active: true,
    dockSearchExpanded: false,
    dockSearchScope: "all",
    dockVisible: true,
    revision: 1,
    shortcut: { binding: null, error: null },
    windows: [],
    workspaceId: "workspace-1"
  };
}

function createResourceClient(
  overrides: Partial<FusionDockResourceClient> = {}
): FusionDockResourceClient {
  return {
    async cancelWorkspaceAgentSessionWithResult() {
      return {} as never;
    },
    async checkWorkspaceTerminalCloseGuard() {
      return { leaderCommand: null, requiresConfirmation: false } as never;
    },
    async listWorkspaceAgentSessions() {
      return { sessions: [] } as never;
    },
    async listWorkspaceApps() {
      return { apps: [] } as never;
    },
    async listWorkspaceTerminals() {
      return { terminals: [] } as never;
    },
    async listWorkspaces() {
      return {
        totalCount: 1,
        workspaces: [
          { id: "workspace-1", lastOpenedAt: null, name: "Workspace One" }
        ]
      };
    },
    async stopWorkspaceApp() {
      return {} as never;
    },
    async terminateWorkspaceTerminal() {
      return {} as never;
    },
    ...overrides
  } as FusionDockResourceClient;
}

function createWorkspaceList() {
  return {
    totalCount: 1,
    workspaces: [
      { id: "workspace-1", lastOpenedAt: null, name: "Workspace One" }
    ]
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not met before timeout");
}

function createWindowDescriptor(
  input: DesktopFusionOpenWindowInput
): DesktopFusionWindowDescriptor {
  return {
    createdAtUnixMs: 1,
    focused: false,
    kind: input.kind,
    lastFocusedAtUnixMs: 0,
    resourceId: input.resourceId ?? null,
    title: input.title ?? null,
    visibility: "visible",
    windowInstanceId: "window-created",
    workspaceId: input.workspaceId
  };
}

function createTerminalResource(
  overrides: Partial<FusionBackgroundResource> = {}
): FusionBackgroundResource {
  return {
    attachedWindowCount: 0,
    canStop: true,
    id: "terminal-1",
    kind: "terminal",
    provider: null,
    status: "running",
    subtitle: null,
    title: "Terminal",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-2",
    workspaceName: "Workspace Two",
    ...overrides,
    category: overrides.category ?? "background-task"
  };
}

function createWorkspaceTerminalSession(id: string): WorkspaceTerminalSession {
  return {
    cols: 80,
    createdAt: "2026-07-12T00:00:00.000Z",
    cwd: "/workspace",
    endedAt: null,
    id,
    lastError: null,
    profileId: null,
    rows: 24,
    runtimeKind: "local",
    status: "running",
    title: "Existing terminal",
    updatedAt: "2026-07-12T00:00:01.000Z",
    workspaceId: "workspace-1"
  };
}

function createAgentResource(
  workspaceId: string,
  provider: string
): FusionBackgroundResource {
  return {
    attachedWindowCount: 1,
    canStop: true,
    category: "background-task",
    id: "agent-session-1",
    kind: "agent",
    provider,
    status: "waiting",
    subtitle: null,
    title: "Agent",
    updatedAtUnixMs: 1,
    workspaceId,
    workspaceName: workspaceId
  };
}
