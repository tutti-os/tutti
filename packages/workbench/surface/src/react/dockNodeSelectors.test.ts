import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchDockNodesSelector } from "./dockNodeSelectors.ts";
import type { WorkbenchNode, WorkbenchState } from "../core/types.ts";

test("dock nodes selector preserves identity across position-only changes", () => {
  const selectDockNodes = createWorkbenchDockNodesSelector();
  const firstState = createState([
    createNode("first", { x: 10, y: 10 }),
    createNode("second", { x: 40, y: 40 })
  ]);
  const firstSelection = selectDockNodes(firstState);
  const secondSelection = selectDockNodes(
    createState([createNode("first", { x: 24, y: 32 }), firstState.nodes[1]!])
  );

  assert.equal(secondSelection, firstSelection);
});

test("dock nodes selector changes identity across size changes", () => {
  const selectDockNodes = createWorkbenchDockNodesSelector();
  const firstState = createState([
    createNode("first", { x: 10, y: 10 }),
    createNode("second", { x: 40, y: 40 })
  ]);
  const firstSelection = selectDockNodes(firstState);
  const secondSelection = selectDockNodes(
    createState([
      {
        ...firstState.nodes[0]!,
        frame: {
          ...firstState.nodes[0]!.frame,
          height: 300,
          width: 420
        }
      },
      firstState.nodes[1]!
    ])
  );

  assert.notEqual(secondSelection, firstSelection);
});

test("dock nodes selector changes identity when dock-visible node state changes", () => {
  const selectDockNodes = createWorkbenchDockNodesSelector();
  const firstSelection = selectDockNodes(
    createState([
      createNode("first", { x: 10, y: 10 }),
      createNode("second", { x: 40, y: 40 })
    ])
  );
  const secondSelection = selectDockNodes(
    createState([
      createNode("first", { x: 10, y: 10 }, { isMinimized: true }),
      createNode("second", { x: 40, y: 40 })
    ])
  );

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
    nodes,
    nodeStack: nodes.map((node) => node.id),
    surfaceSize: { height: 720, width: 1024 }
  };
}

function createNode(
  id: string,
  position: { x: number; y: number },
  options: { isMinimized?: boolean; title?: string } = {}
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
    isMinimized: options.isMinimized ?? false,
    kind: "test",
    minimizedAtUnixMs: options.isMinimized ? 100 : null,
    restoreFrame: null,
    title: options.title ?? id
  };
}
