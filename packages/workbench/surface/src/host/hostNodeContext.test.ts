import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNode } from "../core/types.ts";
import type { WorkbenchRenderNodeContext } from "../react/types.ts";
import type {
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition
} from "./types.ts";
import { createWorkbenchHostNodeBodyContext } from "./hostNodeContext.ts";

test("marks a Mission Control preview as presentation-visible", () => {
  const node = createNode("visible");
  const context = createRenderContext(node, new Set([node.id]));

  const bodyContext = createWorkbenchHostNodeBodyContext({
    context,
    definition: {} as WorkbenchHostNodeDefinition,
    externalState: {
      externalNodeState: null,
      externalWorkspaceState: null
    },
    host: createHost(),
    isVisible: false,
    workspaceId: "workspace-1"
  });

  assert.equal(bodyContext.isVisible, false);
  assert.equal(bodyContext.isPresentationVisible, true);
});

test("does not mark a filtered Mission Control node as presentation-visible", () => {
  const node = createNode("filtered");
  const bodyContext = createWorkbenchHostNodeBodyContext({
    context: createRenderContext(node, new Set()),
    definition: {} as WorkbenchHostNodeDefinition,
    externalState: {
      externalNodeState: null,
      externalWorkspaceState: null
    },
    host: createHost(),
    isVisible: false,
    workspaceId: "workspace-1"
  });

  assert.equal(bodyContext.isPresentationVisible, false);
});

function createNode(id: string): WorkbenchNode<WorkbenchHostNodeData> {
  return {
    data: {
      instanceId: id,
      typeId: "test"
    },
    displayMode: "floating",
    frame: { height: 240, width: 320, x: 0, y: 0 },
    id,
    isMinimized: false,
    kind: "test",
    restoreFrame: null,
    title: id
  };
}

function createRenderContext(
  node: WorkbenchNode<WorkbenchHostNodeData>,
  visibleNodeIds: ReadonlySet<string>
): WorkbenchRenderNodeContext<WorkbenchHostNodeData> {
  return {
    controller:
      {} as WorkbenchRenderNodeContext<WorkbenchHostNodeData>["controller"],
    isDragging: false,
    isResizing: false,
    layout: {
      frame: node.frame,
      isFocused: false,
      presentation: {
        frameByNodeId: new Map([[node.id, node.frame]]),
        mode: "mission-control",
        visibleNodeIds
      },
      zIndex: 1
    },
    node
  };
}

function createHost(): WorkbenchHostHandle {
  return {
    getSnapshot() {
      return { nodes: [], nodeStack: [] };
    }
  } as unknown as WorkbenchHostHandle;
}
