import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle,
  WorkbenchHostLaunchRequest
} from "@tutti-os/workbench-surface";
import {
  createStandaloneAgentDirectToolHost,
  createStandaloneAgentToolHostGroup,
  createStandaloneAgentToolSnapshotRepository,
  resolveStandaloneAgentToolContribution
} from "./standaloneAgentToolWorkbench.ts";

test("standalone Agent terminal contribution keeps the real renderer and opens fullscreen without a dock", async () => {
  const renderBody = () => null;
  const contribution: WorkbenchContribution = {
    dockEntries: [
      {
        icon: null,
        id: "workspace-terminal",
        label: "Terminal",
        typeId: "workspace-terminal"
      }
    ],
    id: "workspace-terminal",
    nodes: [
      {
        frame: { height: 500, width: 800, x: 0, y: 0 },
        renderBody,
        title: "Terminal",
        typeId: "workspace-terminal",
        window: { closable: true, minimizable: true }
      }
    ],
    onLaunchRequest: () => ({
      framePolicy: "cascade",
      instanceId: "terminal-1",
      typeId: "workspace-terminal"
    })
  };

  const resolved = resolveStandaloneAgentToolContribution(
    [contribution],
    "terminal"
  );
  assert.ok(resolved);
  assert.deepEqual(resolved.dockEntries, []);
  assert.equal(resolved.nodes?.[0]?.renderBody, renderBody);
  assert.deepEqual(resolved.nodes?.[0]?.window, {
    closable: false,
    minimizable: false
  });
  const launch = await resolved.onLaunchRequest?.({
    dockEntryId: "workspace-terminal",
    layoutConstraints: {
      minHeight: 0,
      minWidth: 0,
      safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
      surfacePadding: 0
    },
    reason: "host",
    surfaceSize: { height: 600, width: 700 },
    typeId: "workspace-terminal",
    workspaceId: "workspace-1"
  } satisfies WorkbenchHostLaunchRequest);
  assert.equal(launch?.displayMode, "fullscreen");
  assert.equal(launch?.framePolicy, "absolute");
});

test("standalone Agent tool snapshot repository never restores OS workbench windows", async () => {
  const repository = createStandaloneAgentToolSnapshotRepository();
  assert.equal(await repository.load("workspace-1"), null);
});

test("standalone Agent tool host group aggregates terminal close effects and routes node commands", async () => {
  const closedNodeIds: string[] = [];
  const terminalHost = createTestHost(
    "terminal-node",
    [
      {
        description: "running command",
        nodeId: "terminal-node",
        title: "Terminal",
        typeId: "workspace-terminal"
      }
    ],
    closedNodeIds
  );
  const group = createStandaloneAgentToolHostGroup();
  group.setHost("terminal", terminalHost);

  assert.deepEqual(await group.host.collectWindowCloseEffects(), [
    {
      description: "running command",
      nodeId: "terminal-node",
      title: "Terminal",
      typeId: "workspace-terminal"
    }
  ]);
  group.host.closeNode("terminal-node");
  assert.deepEqual(closedNodeIds, ["terminal-node"]);
  assert.equal(group.host.getSnapshot().nodes.length, 1);
});

test("standalone Agent direct terminal host exposes the mounted session to close guards", async () => {
  const directHost = createStandaloneAgentDirectToolHost();
  const closeEffect = {
    description: "running command",
    nodeId: "terminal-node-1",
    title: "zsh",
    typeId: "workspace-terminal"
  };
  directHost.setNode({
    instanceId: "terminal-session-1",
    nodeId: "terminal-node-1",
    resolveCloseEffect: async () => closeEffect,
    title: "zsh",
    typeId: "workspace-terminal"
  });

  assert.deepEqual(directHost.host.getSnapshot().nodes[0]?.data, {
    instanceId: "terminal-session-1",
    instanceKey: "terminal-session-1",
    typeId: "workspace-terminal"
  });
  assert.deepEqual(await directHost.host.collectWindowCloseEffects(), [
    closeEffect
  ]);
  directHost.host.closeNode("terminal-node-1");
  assert.equal(directHost.host.getSnapshot().nodes.length, 0);
});

function createTestHost(
  nodeId: string,
  closeEffects: Awaited<
    ReturnType<WorkbenchHostHandle["collectWindowCloseEffects"]>
  >,
  closedNodeIds: string[]
): WorkbenchHostHandle {
  const snapshot = {
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    layoutConstraints: {
      minHeight: 0,
      minWidth: 0,
      safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
      surfacePadding: 0
    },
    lockedLayout: null,
    nodes: [
      {
        data: { instanceId: nodeId, typeId: "test" },
        displayMode: "floating" as const,
        frame: { height: 100, width: 100, x: 0, y: 0 },
        id: nodeId,
        isMinimized: false,
        kind: "window" as const,
        restoreFrame: null,
        title: nodeId
      }
    ],
    nodeStack: [nodeId],
    surfaceSize: { height: 100, width: 100 }
  };
  return {
    activateNode: () => undefined,
    closeNode: (id) => closedNodeIds.push(id),
    collectWindowCloseEffects: async () => closeEffects,
    dispose: () => undefined,
    exitFullscreenNode: () => undefined,
    focusNode: () => undefined,
    getSnapshot: () => snapshot,
    launchNode: async () => null,
    load: async () => undefined,
    minimizeNode: () => undefined,
    reconcileProjectedNodes: () => undefined,
    requestNodeClose: () => undefined,
    setNodeRuntimeState: () => undefined,
    setNodeSizeConstraints: () => undefined,
    setNodeTitle: () => undefined,
    setSnapshotNodeState: () => undefined
  };
}
