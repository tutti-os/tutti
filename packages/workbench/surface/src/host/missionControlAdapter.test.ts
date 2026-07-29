import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNode } from "../core/types.ts";
import { createWorkbenchController } from "../store/createWorkbenchController.ts";
import { createWorkbenchHostMissionControlAdapter } from "./missionControlAdapter.ts";
import type { WorkbenchHostNodeData } from "./types.ts";

test("mission control adapter exposes locked layout state from the controller", () => {
  const controller = createWorkbenchController<WorkbenchHostNodeData>({
    nodes: [makeNode("node-a"), makeNode("node-b")],
    nodeStack: ["node-a", "node-b"]
  });
  const adapter = createWorkbenchHostMissionControlAdapter({ controller });

  assert.equal(adapter.getSnapshot().isLayoutLocked, false);

  controller.commands.applyLayoutPreset(
    ["node-a", "node-b"],
    { kind: "row" },
    true
  );

  assert.equal(adapter.getSnapshot().isLayoutLocked, true);
});

test("mission control adapter caches snapshots until controller state changes", () => {
  const controller = createWorkbenchController<WorkbenchHostNodeData>({
    nodes: [makeNode("node-a")],
    nodeStack: ["node-a"]
  });
  const adapter = createWorkbenchHostMissionControlAdapter({ controller });

  const firstSnapshot = adapter.getSnapshot();
  const secondSnapshot = adapter.getSnapshot();
  assert.equal(secondSnapshot, firstSnapshot);

  controller.commands.focusNode("node-a");

  const thirdSnapshot = adapter.getSnapshot();
  assert.equal(thirdSnapshot, firstSnapshot);

  controller.commands.minimizeNode("node-a");

  const fourthSnapshot = adapter.getSnapshot();
  assert.notEqual(fourthSnapshot, firstSnapshot);
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
