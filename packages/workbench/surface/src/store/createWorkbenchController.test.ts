import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchController } from "./createWorkbenchController.ts";
import type { WorkbenchNode } from "../core/types.ts";

test("notifies subscribers when commands change state", () => {
  const controller = createWorkbenchController();
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => {
    notifications += 1;
  });

  controller.commands.openNode(makeNode("a"));
  assert.equal(notifications, 1);
  assert.equal(controller.getSnapshot().nodes[0]?.id, "a");

  unsubscribe();
  controller.commands.openNode(makeNode("b"));
  assert.equal(notifications, 1);
});

test("does not notify subscribers when focusing the focused visible node", () => {
  const controller = createWorkbenchController();
  controller.commands.openNode(makeNode("a"));
  const focusedSnapshot = controller.getSnapshot();
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => {
    notifications += 1;
  });

  controller.commands.focusNode("a");

  assert.equal(controller.getSnapshot(), focusedSnapshot);
  assert.equal(notifications, 0);

  controller.commands.minimizeNode("a");
  controller.commands.focusNode("a");
  assert.equal(controller.getSnapshot().nodes[0]?.isMinimized, false);
  assert.equal(notifications, 2);
  unsubscribe();
});

test("reports surface measurements even when the measured size is unchanged", () => {
  let measurements = 0;
  const controller = createWorkbenchController(
    {},
    {
      onSurfaceSizeMeasured() {
        measurements += 1;
      }
    }
  );

  controller.commands.setSurfaceSize({ width: 1024, height: 720 });
  controller.commands.setSurfaceSize({ width: 1280, height: 800 });

  assert.equal(measurements, 2);
});

test("commands match dispatch paths", () => {
  const viaCommand = createWorkbenchController();
  const viaDispatch = createWorkbenchController();
  const node = makeNode("a");

  viaCommand.commands.openNode(node);
  viaDispatch.dispatch({ type: "openNode", node });

  assert.deepEqual(viaCommand.getSnapshot(), viaDispatch.getSnapshot());

  viaCommand.commands.replaceState({
    nodes: [makeNode("b")],
    nodeStack: ["b"]
  });
  viaDispatch.dispatch({
    type: "replaceState",
    state: {
      nodes: [makeNode("b")],
      nodeStack: ["b"]
    }
  });

  assert.deepEqual(viaCommand.getSnapshot(), viaDispatch.getSnapshot());

  viaCommand.commands.applyQuickLayout("b", "right");
  viaDispatch.dispatch({
    type: "applyQuickLayout",
    nodeID: "b",
    target: "right"
  });
  viaCommand.commands.applyLayoutPreset(["b"], { kind: "column" });
  viaDispatch.dispatch({
    type: "applyLayoutPreset",
    nodeIDs: ["b"],
    preset: { kind: "column" }
  });
  viaCommand.commands.applyVisibleLayoutPreset({ kind: "balanced" });
  viaDispatch.dispatch({
    type: "applyVisibleLayoutPreset",
    preset: { kind: "balanced" }
  });

  viaCommand.commands.setActiveSnapTarget("top");
  viaDispatch.dispatch({
    type: "setActiveSnapTarget",
    snapTarget: "top"
  });
  viaCommand.commands.applyActiveSnapTarget("b");
  viaDispatch.dispatch({
    type: "applyActiveSnapTarget",
    nodeID: "b"
  });

  viaCommand.commands.applySnapTarget("b", "top");
  viaDispatch.dispatch({
    type: "applySnapTarget",
    nodeID: "b",
    snapTarget: "top"
  });
  viaCommand.commands.setNodeSizeConstraints("b", {
    minHeight: 320,
    minWidth: 520
  });
  viaDispatch.dispatch({
    type: "setNodeSizeConstraints",
    nodeID: "b",
    sizeConstraints: {
      minHeight: 320,
      minWidth: 520
    }
  });

  assert.deepEqual(viaCommand.getSnapshot(), viaDispatch.getSnapshot());
});

function makeNode(id: string): WorkbenchNode {
  return {
    id,
    kind: "test",
    title: id,
    frame: { x: 32, y: 32, width: 320, height: 220 },
    displayMode: "floating",
    restoreFrame: null,
    isMinimized: false,
    data: null
  };
}
