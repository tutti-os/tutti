import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchNode,
  WorkbenchState
} from "@tutti-os/workbench-surface";
import {
  workspaceFilePreviewActivationType,
  workspaceImageFileNodeTypeID,
  workspaceTextFileNodeTypeID
} from "../../../workspace-workbench/services/workspaceFilePreviewLaunch.ts";
import { resolveWorkbenchDockFileMentionItems } from "./resolveWorkbenchDockFileMentionItems.ts";

const workspaceId = "workspace-1";
const defaultFrame = { x: 0, y: 0, width: 640, height: 480 };

function createTestNode(input: {
  id: string;
  data: WorkbenchHostNodeData;
  title?: string;
}): WorkbenchNode<WorkbenchHostNodeData> {
  return {
    id: input.id,
    kind: "test",
    title: input.title ?? input.id,
    frame: defaultFrame,
    displayMode: "floating",
    restoreFrame: null,
    isMinimized: false,
    minimizedAtUnixMs: null,
    data: input.data
  };
}

function createHost(input: {
  nodeStack: string[];
  nodes: WorkbenchNode<WorkbenchHostNodeData>[];
}): Pick<WorkbenchHostHandle, "getSnapshot"> {
  const snapshot: WorkbenchState<WorkbenchHostNodeData> = {
    nodes: input.nodes,
    nodeStack: input.nodeStack,
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    lockedLayout: null,
    surfaceSize: { width: 1024, height: 720 },
    layoutConstraints: {
      minWidth: 280,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 88, left: 0 }
    }
  };

  return {
    getSnapshot: () => snapshot
  };
}

test("resolveWorkbenchDockFileMentionItems returns open file preview nodes in stack order", () => {
  const items = resolveWorkbenchDockFileMentionItems({
    host: createHost({
      nodeStack: ["preview-b", "preview-a"],
      nodes: [
        createTestNode({
          id: "preview-a",
          title: "alpha.ts",
          data: {
            activation: {
              payload: {
                previewKind: "text",
                mtimeMs: null,
                name: "alpha.ts",
                path: "/workspace/alpha.ts",
                sizeBytes: null
              },
              sequence: 1,
              type: workspaceFilePreviewActivationType
            },
            instanceId: "path:aaa",
            typeId: workspaceTextFileNodeTypeID
          }
        }),
        createTestNode({
          id: "preview-b",
          title: "beta.ts",
          data: {
            activation: {
              payload: {
                previewKind: "text",
                mtimeMs: null,
                name: "beta.ts",
                path: "/workspace/beta.ts",
                sizeBytes: null
              },
              sequence: 1,
              type: workspaceFilePreviewActivationType
            },
            instanceId: "path:bbb",
            typeId: workspaceTextFileNodeTypeID
          }
        }),
        createTestNode({
          id: "agent-gui",
          title: "Agent",
          data: {
            instanceId: "agent-gui",
            typeId: "agent-gui"
          }
        })
      ]
    }),
    workspaceId
  });

  assert.deepEqual(items, [
    {
      displayName: "beta.ts",
      kind: "file",
      path: "/workspace/beta.ts",
      previewCacheKey: {
        instanceId: "path:bbb",
        instanceKey: null,
        nodeId: "preview-b",
        typeId: workspaceTextFileNodeTypeID,
        workspaceId
      }
    },
    {
      displayName: "alpha.ts",
      kind: "file",
      path: "/workspace/alpha.ts",
      previewCacheKey: {
        instanceId: "path:aaa",
        instanceKey: null,
        nodeId: "preview-a",
        typeId: workspaceTextFileNodeTypeID,
        workspaceId
      }
    }
  ]);
});

test("resolveWorkbenchDockFileMentionItems includes image previews restored from snapshot state", () => {
  const items = resolveWorkbenchDockFileMentionItems({
    host: createHost({
      nodeStack: ["preview-image"],
      nodes: [
        createTestNode({
          id: "preview-image",
          title: "diagram.png",
          data: {
            activation: null,
            instanceId: "path:img",
            snapshotNodeState: {
              file: {
                previewKind: "image",
                mtimeMs: null,
                name: "diagram.png",
                path: "/workspace/assets/diagram.png",
                sizeBytes: 1024
              }
            },
            typeId: workspaceImageFileNodeTypeID
          }
        })
      ]
    }),
    workspaceId
  });

  assert.deepEqual(items, [
    {
      displayName: "diagram.png",
      kind: "file",
      path: "/workspace/assets/diagram.png",
      previewCacheKey: {
        instanceId: "path:img",
        instanceKey: null,
        nodeId: "preview-image",
        typeId: workspaceImageFileNodeTypeID,
        workspaceId
      }
    }
  ]);
});

test("resolveWorkbenchDockFileMentionItems reads preview targets from runtime node state", () => {
  const items = resolveWorkbenchDockFileMentionItems({
    host: createHost({
      nodeStack: ["preview-text"],
      nodes: [
        createTestNode({
          id: "preview-text",
          title: "notes.md",
          data: {
            activation: null,
            instanceId: "path:txt",
            runtimeNodeState: {
              file: {
                previewKind: "text",
                mtimeMs: null,
                name: "notes.md",
                path: "/workspace/notes.md",
                sizeBytes: 42
              }
            },
            typeId: workspaceTextFileNodeTypeID
          }
        })
      ]
    }),
    workspaceId
  });

  assert.deepEqual(items, [
    {
      displayName: "notes.md",
      kind: "file",
      path: "/workspace/notes.md",
      previewCacheKey: {
        instanceId: "path:txt",
        instanceKey: null,
        nodeId: "preview-text",
        typeId: workspaceTextFileNodeTypeID,
        workspaceId
      }
    }
  ]);
});
