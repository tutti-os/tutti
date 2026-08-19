import assert from "node:assert/strict";
import test from "node:test";
import type {
  TrackEvent,
  TuttidClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  createWorkspaceLaunch as createWorkspaceLaunchCore,
  type WorkspaceLaunch,
  type WorkspaceLaunchAdapters,
  type WorkspaceLaunchDependencies,
  type WorkspaceLaunchOwnerWindow
} from "./workspaceLaunch.ts";

type StartupWorkspaceClient = Pick<
  TuttidClient,
  "getStartupWorkspace" | "trackEvents"
>;

function createWorkspaceSummary(id: string): WorkspaceSummary {
  return {
    id,
    name: `Workspace ${id}`,
    lastOpenedAt: "2026-05-21T08:00:00Z"
  };
}

function createStartupWorkspaceClient(
  getStartupWorkspace: StartupWorkspaceClient["getStartupWorkspace"] = async () =>
    null,
  trackEvents: StartupWorkspaceClient["trackEvents"] = async () => {}
): StartupWorkspaceClient {
  return { getStartupWorkspace, trackEvents };
}

function createAdapters(
  overrides: Partial<WorkspaceLaunchAdapters> = {}
): WorkspaceLaunchAdapters {
  return {
    async ensureAgentBrowserHost() {},
    async showAgentWindow() {},
    async showWorkspaceWindow() {},
    warnStartupWindowResolutionFailure() {},
    ...overrides
  };
}

function createWorkspaceLaunch(
  deps: Omit<
    WorkspaceLaunchDependencies,
    "getPrimaryWorkspaceWindowOptions"
  > & {
    getPrimaryWorkspaceWindowOptions?: WorkspaceLaunchDependencies["getPrimaryWorkspaceWindowOptions"];
  }
): WorkspaceLaunch {
  return createWorkspaceLaunchCore({
    ...deps,
    getPrimaryWorkspaceWindowOptions:
      deps.getPrimaryWorkspaceWindowOptions ??
      (() => ({ windowKind: "workspace", workspaceUiMode: "os" }))
  });
}

test("workspace launch ensures an exact User Browser host", async () => {
  const calls: Array<{
    options:
      | {
          windowKind: "agent" | "workspace";
          workspaceUiMode: "agent" | "os";
        }
      | undefined;
    workspaceID: string;
  }> = [];
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID, options) {
        calls.push({ options, workspaceID });
      }
    }),
    getPrimaryWorkspaceWindowOptions: () => ({
      windowKind: "agent",
      workspaceUiMode: "agent"
    }),
    tuttidClient: createStartupWorkspaceClient()
  });

  await launch.ensureUserBrowserHost("ws-browser");

  assert.deepEqual(calls, [
    {
      options: { windowKind: "workspace", workspaceUiMode: "agent" },
      workspaceID: "ws-browser"
    }
  ]);
});

test("workspace launch opens the daemon-resolved startup workspace", async () => {
  let startupCalls = 0;
  let openedWindow:
    | {
        windowKind: "agent" | "workspace";
        workspaceID: string;
        workspaceUiMode: "agent" | "os";
      }
    | undefined;

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID, options) {
        openedWindow = { ...options, workspaceID };
      }
    }),
    getPrimaryWorkspaceWindowOptions: () => ({
      windowKind: "agent",
      workspaceUiMode: "agent"
    }),
    tuttidClient: createStartupWorkspaceClient(async () => {
      startupCalls += 1;
      return createWorkspaceSummary("ws-start");
    })
  });

  await launch.openStartupWindow();

  assert.equal(startupCalls, 1);
  assert.deepEqual(openedWindow, {
    windowKind: "agent",
    workspaceUiMode: "agent",
    workspaceID: "ws-start"
  });
});

test("workspace launch gives an auxiliary Agent window the global OS preference bootstrap", async () => {
  let openedInput:
    | { workspaceID: string; workspaceUiMode: "agent" | "os" }
    | undefined;
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showAgentWindow(input) {
        openedInput = {
          workspaceID: input.workspaceID,
          workspaceUiMode: input.workspaceUiMode
        };
      }
    }),
    tuttidClient: createStartupWorkspaceClient()
  });

  await launch.showAgentWindow({ workspaceID: "ws-agent" });

  assert.deepEqual(openedInput, {
    workspaceID: "ws-agent",
    workspaceUiMode: "os"
  });
});

test("workspace launch warns and rejects when startup resolution fails", async () => {
  const error = new Error("boom");
  let warnedError: unknown = null;

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      warnStartupWindowResolutionFailure(receivedError) {
        warnedError = receivedError;
      }
    }),
    tuttidClient: createStartupWorkspaceClient(async () => {
      throw error;
    })
  });

  await assert.rejects(launch.openStartupWindow(), error);
  assert.equal(warnedError, error);
});

test("workspace launch waits for replacement workspace window before closing owner", async () => {
  let ownerWindowClosed = false;
  let resolveWorkspaceWindow: (() => void) | undefined;
  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      ownerWindowClosed = true;
    }
  };
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow() {
        await new Promise<void>((resolve) => {
          resolveWorkspaceWindow = resolve;
        });
      }
    }),
    tuttidClient: createStartupWorkspaceClient()
  });

  const openPromise = launch.showWorkspace(ownerWindow, "ws-alpha");
  await Promise.resolve();

  assert.equal(ownerWindowClosed, false);
  assert.ok(resolveWorkspaceWindow);
  resolveWorkspaceWindow();

  await openPromise;
  assert.equal(ownerWindowClosed, true);
});

test("workspace launch hands analytics to main after the new window is ready and before closing the owner", async () => {
  const events: string[] = [];
  const tracked: TrackEvent[][] = [];
  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      events.push("owner:closed");
    }
  };
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID, options) {
        events.push(
          `${workspaceID}:${options.windowKind}:${options.workspaceUiMode}`
        );
      }
    }),
    tuttidClient: createStartupWorkspaceClient(
      undefined,
      async (nextEvents) => {
        events.push("analytics:accepted");
        tracked.push([...nextEvents]);
      }
    )
  });

  await launch.replaceWorkspaceWindow(ownerWindow, {
    clientTS: 1749124800000,
    mode: "agent",
    previousMode: "os",
    workspaceID: "ws-alpha"
  });

  assert.deepEqual(events, [
    "ws-alpha:agent:agent",
    "analytics:accepted",
    "owner:closed"
  ]);
  assert.deepEqual(tracked, [
    [
      {
        client_ts: 1749124800000,
        name: "settings.workspace_ui_mode_changed",
        params: {
          action: "enabled",
          next_mode: "agent",
          previous_mode: "os"
        }
      }
    ]
  ]);
});

test("workspace launch does not wait for mode analytics before closing the owner", async () => {
  let releaseAnalytics: (() => void) | undefined;
  const analyticsPending = new Promise<void>((resolve) => {
    releaseAnalytics = resolve;
  });
  const events: string[] = [];
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow() {
        events.push("workspace:shown");
      }
    }),
    tuttidClient: createStartupWorkspaceClient(undefined, async () => {
      events.push("analytics:started");
      await analyticsPending;
    })
  });

  await launch.replaceWorkspaceWindow(null, {
    clientTS: 1749124800000,
    mode: "os",
    previousMode: "agent",
    workspaceID: "ws-alpha"
  });

  assert.deepEqual(events, ["workspace:shown", "analytics:started"]);
  releaseAnalytics?.();
  await analyticsPending;
});

test("workspace launch isolates rejected mode analytics from replacement", async () => {
  const errors: unknown[] = [];
  let ownerClosed = false;
  const launch = createWorkspaceLaunch({
    adapters: createAdapters(),
    onAnalyticsError(error) {
      errors.push(error);
    },
    tuttidClient: createStartupWorkspaceClient(undefined, async () => {
      throw new Error("analytics unavailable");
    })
  });

  await launch.replaceWorkspaceWindow(
    {
      close() {
        ownerClosed = true;
      }
    },
    {
      clientTS: 1749124800000,
      mode: "agent",
      previousMode: "os",
      workspaceID: "ws-alpha"
    }
  );
  await Promise.resolve();

  assert.equal(ownerClosed, true);
  assert.equal((errors[0] as Error).message, "analytics unavailable");
});

test("workspace launch prefers destroying owner windows after workspace handoff", async () => {
  const events: string[] = [];
  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      events.push("owner:closed");
    },
    destroy() {
      events.push("owner:destroyed");
    }
  };
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID) {
        events.push(`workspace:${workspaceID}`);
      }
    }),
    tuttidClient: createStartupWorkspaceClient()
  });

  await launch.showWorkspace(ownerWindow, "ws-destroy");

  assert.deepEqual(events, ["workspace:ws-destroy", "owner:destroyed"]);
});

test("workspace launch keeps a reused durable workspace owner open", async () => {
  const events: string[] = [];
  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      events.push("owner:closed");
    },
    destroy() {
      events.push("owner:destroyed");
    }
  };
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID) {
        events.push(`workspace:${workspaceID}:reused`);
        return ownerWindow;
      }
    }),
    tuttidClient: createStartupWorkspaceClient()
  });

  await launch.showWorkspace(ownerWindow, "ws-existing-owner");

  assert.deepEqual(events, ["workspace:ws-existing-owner:reused"]);
});

test("workspace launch keeps owner open when replacement workspace window fails", async () => {
  let ownerWindowClosed = false;
  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      ownerWindowClosed = true;
    }
  };
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow() {
        throw new Error("renderer failed");
      }
    }),
    tuttidClient: createStartupWorkspaceClient()
  });

  await assert.rejects(
    launch.showWorkspace(ownerWindow, "ws-alpha"),
    /renderer failed/
  );
  assert.equal(ownerWindowClosed, false);
});

test("workspace launch still hands off mode analytics when replacement fails", async () => {
  const tracked: TrackEvent[][] = [];
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow() {
        throw new Error("renderer failed");
      }
    }),
    tuttidClient: createStartupWorkspaceClient(undefined, async (events) => {
      tracked.push([...events]);
    })
  });

  await assert.rejects(
    launch.replaceWorkspaceWindow(null, {
      clientTS: 1749124800000,
      mode: "os",
      previousMode: "agent",
      workspaceID: "ws-alpha"
    }),
    /renderer failed/
  );

  assert.equal(tracked.length, 1);
  assert.equal(tracked[0]?.[0]?.name, "settings.workspace_ui_mode_changed");
});

test("workspace launch warns and rejects when startup workspace window fails", async () => {
  const error = new Error("workspace failed");
  let warnedError: unknown = null;
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow() {
        throw error;
      },
      warnStartupWindowResolutionFailure(receivedError) {
        warnedError = receivedError;
      }
    }),
    tuttidClient: createStartupWorkspaceClient(async () =>
      createWorkspaceSummary("ws-start")
    )
  });

  await assert.rejects(launch.openStartupWindow(), error);
  assert.equal(warnedError, error);
});
