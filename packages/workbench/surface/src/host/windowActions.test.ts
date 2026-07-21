import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNode } from "../core/types.ts";
import { createWorkbenchController } from "../store/createWorkbenchController.ts";
import { createWorkbenchHostNodeHeaderWindowActions } from "./windowActions.ts";
import type { WorkbenchHostNodeData } from "./types.ts";

test("host header window actions expose quick layout and resize", () => {
  const controller = createWorkbenchController<WorkbenchHostNodeData>({
    surfaceSize: { width: 1200, height: 800 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("node-a")],
    nodeStack: ["node-a"]
  });
  const node = controller.getSnapshot().nodes[0];
  assert.ok(node);

  const actions = createWorkbenchHostNodeHeaderWindowActions({
    controller,
    defaultActions: null,
    dragHandleProps: {
      "data-workbench-drag-handle": "true",
      onDoubleClick: () => {},
      onPointerDown: () => {}
    },
    genie: { minimizeNodeToAnchor: (_nodeID, minimize) => minimize?.() },
    isDragging: false,
    isFocused: false,
    isResizing: false,
    node,
    renderRevision: {},
    surfaceSize: controller.getSnapshot().surfaceSize
  });

  actions.applyQuickLayout("right");
  assert.deepEqual(controller.getSnapshot().nodes[0]?.frame, {
    x: 900,
    y: 52,
    width: 300,
    height: 684
  });

  actions.resize({ x: 360, y: 80, width: 640, height: 420 });
  assert.deepEqual(controller.getSnapshot().nodes[0]?.frame, {
    x: 360,
    y: 80,
    width: 640,
    height: 420
  });
  assert.deepEqual(actions.getFrame(), {
    x: 360,
    y: 80,
    width: 640,
    height: 420
  });
});

function makeNode(id: string): WorkbenchNode<WorkbenchHostNodeData> {
  return {
    data: {
      instanceId: id,
      instanceKey: null,
      typeId: "test"
    },
    displayMode: "floating",
    frame: { x: 24, y: 24, width: 320, height: 220 },
    id,
    isMinimized: false,
    kind: "test",
    restoreFrame: null,
    title: `Node ${id}`
  };
}
