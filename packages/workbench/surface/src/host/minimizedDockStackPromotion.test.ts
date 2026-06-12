import assert from "node:assert/strict";
import test from "node:test";
import { detectMinimizedDockStackPromotion } from "./minimizedDockStackPromotion.ts";
import type { WorkbenchMinimizedDockNode } from "./minimizedDockSlots.ts";
import type { WorkbenchMinimizedDockSlot } from "./minimizedDockSlots.ts";

function createNode(id: string): WorkbenchMinimizedDockNode {
  return {
    data: {
      dockEntryId: id,
      instanceId: id,
      launchSource: "dock",
      typeId: "test"
    },
    displayMode: "floating",
    frame: { height: 480, width: 640, x: 0, y: 0 },
    id,
    isMinimized: true,
    kind: "test",
    minimizedAtUnixMs: 1,
    restoreFrame: null,
    title: id
  };
}

function nodeSlot(id: string): WorkbenchMinimizedDockSlot {
  return {
    anchorKey: `minimized:${id}`,
    kind: "node",
    node: createNode(id)
  };
}

function stackSlot(ids: readonly string[]): WorkbenchMinimizedDockSlot {
  return {
    anchorKey: "minimized-stack",
    kind: "stack",
    nodes: ids.map((id) => createNode(id))
  };
}

test("detectMinimizedDockStackPromotion returns a node promoted from the stack", () => {
  const previous = [nodeSlot("a"), nodeSlot("b"), stackSlot(["c", "d"])];
  const next = [nodeSlot("a"), nodeSlot("c"), stackSlot(["d"])];

  assert.equal(detectMinimizedDockStackPromotion(previous, next), "c");
});

test("detectMinimizedDockStackPromotion ignores newly minimized nodes outside the stack", () => {
  const previous = [nodeSlot("a"), stackSlot(["b"])];
  const next = [nodeSlot("a"), nodeSlot("z"), stackSlot(["b"])];

  assert.equal(detectMinimizedDockStackPromotion(previous, next), null);
});
