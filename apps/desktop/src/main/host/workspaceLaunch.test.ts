import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttidClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  createWorkspaceLaunch,
  type WorkspaceLaunchAdapters,
  type WorkspaceLaunchOwnerWindow
} from "./workspaceLaunch.ts";

type StartupWorkspaceClient = Pick<TuttidClient, "getStartupWorkspace">;

function createWorkspaceSummary(id: string): WorkspaceSummary {
  return {
    id,
    name: `Workspace ${id}`,
    lastOpenedAt: "2026-05-21T08:00:00Z"
  };
}

function createStartupWorkspaceClient(
  getStartupWorkspace: StartupWorkspaceClient["getStartupWorkspace"] = async () =>
    null
): StartupWorkspaceClient {
  return { getStartupWorkspace };
}

function createAdapters(
  overrides: Partial<WorkspaceLaunchAdapters> = {}
): WorkspaceLaunchAdapters {
  return {
    async showAgentWindow() {},
    async showWorkspaceWindow() {},
    warnStartupWindowResolutionFailure() {},
    ...overrides
  };
}

test("workspace launch opens the daemon-resolved startup workspace", async () => {
  let startupCalls = 0;
  let openedWorkspaceID: string | null = null;

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID) {
        openedWorkspaceID = workspaceID;
      }
    }),
    tuttidClient: createStartupWorkspaceClient(async () => {
      startupCalls += 1;
      return createWorkspaceSummary("ws-start");
    })
  });

  await launch.openStartupWindow();

  assert.equal(startupCalls, 1);
  assert.equal(openedWorkspaceID, "ws-start");
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

test("workspace launch replacement uses the requested native window kind", async () => {
  const events: string[] = [];
  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      events.push("owner:closed");
    }
  };
  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID, options) {
        events.push(`${workspaceID}:${options?.windowKind}`);
      }
    }),
    tuttidClient: createStartupWorkspaceClient()
  });

  await launch.replaceWorkspaceWindow(ownerWindow, "ws-alpha", "agent");

  assert.deepEqual(events, ["ws-alpha:agent", "owner:closed"]);
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
