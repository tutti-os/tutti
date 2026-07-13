import assert from "node:assert/strict";
import test from "node:test";
import { createRenderedWorkbenchNodeIDsSelector } from "./renderedNodeIds.ts";
import type { WorkbenchNode, WorkbenchState } from "../core/types.ts";

test("rendered node id selector preserves identity across frame-only changes", () => {
  const selectRenderedNodeIDs = createRenderedWorkbenchNodeIDsSelector();
  const firstState = createState([
    createNode("first", { x: 10, y: 10 }),
    createNode("second", { x: 40, y: 40 })
  ]);
  const firstSelection = selectRenderedNodeIDs(firstState);
  const secondSelection = selectRenderedNodeIDs(
    createState([createNode("first", { x: 24, y: 32 }), firstState.nodes[1]!])
  );

  assert.deepEqual(firstSelection, ["first", "second"]);
  assert.equal(secondSelection, firstSelection);
});

test("rendered node id selector changes identity when visible membership changes", () => {
  const selectRenderedNodeIDs = createRenderedWorkbenchNodeIDsSelector();
  const firstSelection = selectRenderedNodeIDs(
    createState([
      createNode("first", { x: 10, y: 10 }),
      createNode("second", { x: 40, y: 40 })
    ])
  );
  const secondSelection = selectRenderedNodeIDs(
    createState([
      createNode("first", { x: 10, y: 10 }),
      createNode("second", { x: 40, y: 40 }, true)
    ])
  );

  assert.deepEqual(secondSelection, ["first"]);
  assert.notEqual(secondSelection, firstSelection);
});

function createState(nodes: WorkbenchNode[]): WorkbenchState {
  return {
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    layoutConstraints: {
      minHeight: 160,
      minWidth: 280,
      safeArea: { bottom: 88, left: 0, right: 0, top: 52 },
      surfacePadding: 0
    },
    lockedLayout: null,
    nodes,
    nodeStack: nodes.map((node) => node.id),
    surfaceSize: { height: 720, width: 1024 }
  };
}

function createNode(
  id: string,
  position: { x: number; y: number },
  isMinimized = false
): WorkbenchNode {
  return {
    data: null,
    displayMode: "floating",
    frame: {
      height: 240,
      width: 320,
      x: position.x,
      y: position.y
    },
    id,
    isMinimized,
    kind: "test",
    minimizedAtUnixMs: null,
    restoreFrame: null,
    title: id
  };
}
