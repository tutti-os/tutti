import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import { createWindowCloseRequestTracker } from "../windowCloseRequestTracker.ts";
import type { WorkspaceWorkbenchHostInput } from "../workspaceWorkbenchHostService.interface.ts";
import { confirmWorkspaceWindowClose } from "./workspaceWindowCloseCoordinator.ts";

test("confirmWorkspaceWindowClose requests focused workbench node close before window close", async () => {
  let approvedCloseCount = 0;
  let closeGuardCount = 0;
  const events: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    createWindowCloseDialogRequest: () => ({
      cancelLabel: "Cancel",
      confirmLabel: "Close",
      description: "There is work running.",
      scope: "window",
      title: "Close window?"
    }),
    prepareHostClose: async () => {
      assert.fail("window close should not prepare workbench nodes");
      return true;
    },
    snapshotRepository: {} as never,
    workspaceId: "workspace-1"
  };

  const outcome = await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => {
      closeGuardCount += 1;
      return false;
    },
    host: createWorkbenchHostHandleStub({
      focusedNodeId: "workspace-app-1",
      nodeIds: ["workspace-app-1"],
      onCloseNode: () => assert.fail("window close should not close nodes"),
      onMinimizeNode: () =>
        assert.fail("window close should not minimize nodes"),
      onRequestNodeClose: (nodeId) => {
        events.push(`node-request-close:${nodeId}`);
      }
    }),
    hostInput,
    reason: "window-close",
    requestApprovedClose: async () => {
      approvedCloseCount += 1;
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.equal(closeGuardCount, 0);
  assert.equal(approvedCloseCount, 0);
  assert.deepEqual(events, ["node-request-close:workspace-app-1"]);
  assert.equal(outcome, "blocked");
});

test("confirmWorkspaceWindowClose does not prepare host close before approving window close", async () => {
  let approvedCloseCount = 0;
  const preparedWorkspaceIds: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    prepareHostClose: async ({ workspaceId }) => {
      preparedWorkspaceIds.push(workspaceId);
      return false;
    },
    snapshotRepository: {} as never,
    workspaceId: "workspace-2"
  };

  await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => true,
    host: createWorkbenchHostHandleStub(),
    hostInput,
    reason: "window-close",
    requestApprovedClose: async () => {
      approvedCloseCount += 1;
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.deepEqual(preparedWorkspaceIds, []);
  assert.equal(approvedCloseCount, 1);
});

test("confirmWorkspaceWindowClose approves window close without stopping workspace apps", async () => {
  const events: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    createWindowCloseDialogRequest: () => ({
      cancelLabel: "Cancel",
      confirmLabel: "Close",
      description: "There is work running.",
      scope: "window",
      title: "Close window?"
    }),
    prepareHostClose: async ({ workspaceId }) => {
      events.push(`prepare:${workspaceId}`);
      return true;
    },
    snapshotRepository: {} as never,
    workspaceId: "workspace-3"
  };

  await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => {
      events.push("confirm");
      return true;
    },
    host: createWorkbenchHostHandleStub(),
    hostInput,
    reason: "window-close",
    requestApprovedClose: async () => {
      events.push("approve");
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.deepEqual(events, ["approve"]);
});

test("confirmWorkspaceWindowClose falls back to visible node when focused id is stale", async () => {
  const events: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    snapshotRepository: {} as never,
    workspaceId: "workspace-5"
  };

  const outcome = await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => true,
    host: createWorkbenchHostHandleStub({
      focusedNodeId: "stale-node",
      nodeIds: ["live-node"],
      onMinimizeNode: () =>
        assert.fail("window close should not minimize nodes"),
      onRequestNodeClose: (nodeId) => {
        events.push(`node-request-close:${nodeId}`);
      }
    }),
    hostInput,
    reason: "window-close",
    requestApprovedClose: async () => {
      events.push("approve");
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.deepEqual(events, ["node-request-close:live-node"]);
  assert.equal(outcome, "blocked");
});

test("confirmWorkspaceWindowClose requests last visible node close when focus stack is empty", async () => {
  const events: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    snapshotRepository: {} as never,
    workspaceId: "workspace-6"
  };

  const outcome = await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => true,
    host: createWorkbenchHostHandleStub({
      nodeIds: ["workspace-files", "workspace-app-1"],
      onMinimizeNode: () =>
        assert.fail("window close should not minimize nodes"),
      onRequestNodeClose: (nodeId) => {
        events.push(`node-request-close:${nodeId}`);
      }
    }),
    hostInput,
    reason: "window-close",
    requestApprovedClose: async () => {
      events.push("approve");
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.deepEqual(events, ["node-request-close:workspace-app-1"]);
  assert.equal(outcome, "blocked");
});

test("confirmWorkspaceWindowClose approves host close when every node is minimized", async () => {
  const events: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    snapshotRepository: {} as never,
    workspaceId: "workspace-7"
  };

  await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => true,
    host: createWorkbenchHostHandleStub({
      minimizedNodeIds: ["workspace-app-1"],
      nodeIds: ["workspace-app-1"],
      onMinimizeNode: (nodeId) => {
        events.push(`node-minimize:${nodeId}`);
      }
    }),
    hostInput,
    reason: "window-close",
    requestApprovedClose: async () => {
      events.push("approve");
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.deepEqual(events, ["approve"]);
});

test("confirmWorkspaceWindowClose closes the focused workbench node and blocks host quit", async () => {
  const events: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    prepareHostClose: async ({ workspaceId }) => {
      events.push(`prepare:${workspaceId}`);
      return true;
    },
    snapshotRepository: {} as never,
    workspaceId: "workspace-8"
  };

  const outcome = await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => {
      events.push("confirm");
      return true;
    },
    host: createWorkbenchHostHandleStub({
      focusedNodeId: "workspace-app-1",
      nodeIds: ["workspace-files", "workspace-app-1"],
      onCloseNode: (nodeId) => {
        events.push(`node-close:${nodeId}`);
      },
      onMinimizeNode: (nodeId) => {
        events.push(`node-minimize:${nodeId}`);
      },
      onRequestNodeClose: (nodeId) => {
        events.push(`node-request-close:${nodeId}`);
      }
    }),
    hostInput,
    reason: "quit",
    requestApprovedClose: async () => {
      events.push("approve");
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.deepEqual(events, [
    "prepare:workspace-8",
    "node-close:workspace-app-1"
  ]);
  assert.equal(outcome, "blocked");
});

test("confirmWorkspaceWindowClose closes the last node when quit focus is stale", async () => {
  const events: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    prepareHostClose: async ({ workspaceId }) => {
      events.push(`prepare:${workspaceId}`);
      return true;
    },
    snapshotRepository: {} as never,
    workspaceId: "workspace-11"
  };

  const outcome = await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => true,
    host: createWorkbenchHostHandleStub({
      focusedNodeId: "stale-node",
      nodeIds: ["workspace-files", "workspace-app-1"],
      onCloseNode: (nodeId) => {
        events.push(`node-close:${nodeId}`);
      }
    }),
    hostInput,
    reason: "quit",
    requestApprovedClose: async () => {
      events.push("approve");
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.deepEqual(events, [
    "prepare:workspace-11",
    "node-close:workspace-app-1"
  ]);
  assert.equal(outcome, "blocked");
});

test("confirmWorkspaceWindowClose keeps host open when quit preparation fails", async () => {
  const events: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    prepareHostClose: async ({ workspaceId }) => {
      events.push(`prepare:${workspaceId}`);
      return false;
    },
    snapshotRepository: {} as never,
    workspaceId: "workspace-9"
  };

  const outcome = await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => true,
    host: createWorkbenchHostHandleStub({
      nodeIds: ["workspace-app-1"],
      onCloseNode: (nodeId) => {
        events.push(`node-close:${nodeId}`);
      }
    }),
    hostInput,
    reason: "quit",
    requestApprovedClose: async () => {
      events.push("approve");
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.deepEqual(events, ["prepare:workspace-9"]);
  assert.equal(outcome, "blocked");
});

test("confirmWorkspaceWindowClose approves quit when no workbench nodes remain", async () => {
  const events: string[] = [];
  const hostInput: WorkspaceWorkbenchHostInput = {
    prepareHostClose: async ({ workspaceId }) => {
      events.push(`prepare:${workspaceId}`);
      return true;
    },
    snapshotRepository: {} as never,
    workspaceId: "workspace-10"
  };

  const outcome = await confirmWorkspaceWindowClose({
    confirmCloseGuard: async () => true,
    host: createWorkbenchHostHandleStub(),
    hostInput,
    reason: "quit",
    requestApprovedClose: async () => {
      events.push("approve");
    },
    tracker: createWindowCloseRequestTracker()
  });

  assert.deepEqual(events, ["approve"]);
  assert.equal(outcome, "approved");
});

function createWorkbenchHostHandleStub(
  input: {
    focusedNodeId?: string | null;
    minimizedNodeIds?: string[];
    nodeIds?: string[];
    onCloseNode?: (nodeId: string) => void;
    onMinimizeNode?: (nodeId: string) => void;
    onRequestNodeClose?: (nodeId: string) => void;
  } = {}
): WorkbenchHostHandle {
  return {
    activateNode() {
      return undefined;
    },
    closeNode(nodeId) {
      input.onCloseNode?.(nodeId);
    },
    collectWindowCloseEffects: async () => [
      {
        nodeId: "node-1",
        title: "Terminal",
        typeId: "workspace-terminal"
      }
    ],
    dispose() {
      return undefined;
    },
    exitFullscreenNode() {
      return undefined;
    },
    focusNode() {
      return undefined;
    },
    getSnapshot() {
      return {
        activeDragNodeId: null,
        activeResizeNodeId: null,
        activeSnapTarget: null,
        layoutConstraints: {} as never,
        lockedLayout: null,
        nodes: (input.nodeIds ?? []).map((id) => ({
          data: {} as never,
          displayMode: "floating",
          frame: {} as never,
          id,
          isMinimized: input.minimizedNodeIds?.includes(id) ?? false,
          kind: "window",
          restoreFrame: null,
          title: id
        })),
        nodeStack: input.focusedNodeId ? [input.focusedNodeId] : [],
        surfaceSize: { height: 800, width: 1200 }
      };
    },
    launchNode: async () => null,
    load: async () => undefined,
    minimizeNode(nodeId) {
      input.onMinimizeNode?.(nodeId);
    },
    reconcileProjectedNodes() {
      return undefined;
    },
    requestNodeClose(nodeId) {
      input.onRequestNodeClose?.(nodeId);
    },
    setNodeRuntimeState() {
      return undefined;
    },
    setNodeSizeConstraints() {
      return undefined;
    },
    setSnapshotNodeState() {
      return undefined;
    },
    setNodeTitle() {
      return undefined;
    }
  };
}
