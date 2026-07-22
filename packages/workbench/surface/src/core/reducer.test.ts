import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkbenchInitialState,
  reduceWorkbenchState
} from "./reducer.ts";
import {
  selectFocusedVisibleWorkbenchNode,
  selectFocusedWorkbenchNode,
  selectFullscreenNodeToExitBeforeDockLaunch
} from "./selectors.ts";
import type { WorkbenchNode } from "./types.ts";

test("opens, focuses, minimizes, and restores nodes", (t) => {
  t.mock.method(Date, "now", () => 1720000000000);

  let state = createWorkbenchInitialState();
  state = reduceWorkbenchState(state, {
    type: "openNode",
    node: makeNode("a")
  });
  state = reduceWorkbenchState(state, {
    type: "openNode",
    node: makeNode("b")
  });

  assert.equal(selectFocusedWorkbenchNode(state)?.id, "b");

  state = reduceWorkbenchState(state, { type: "focusNode", nodeID: "a" });
  assert.equal(selectFocusedWorkbenchNode(state)?.id, "a");

  state = reduceWorkbenchState(state, { type: "minimizeNode", nodeID: "a" });
  assert.equal(state.nodes.find((node) => node.id === "a")?.isMinimized, true);
  assert.equal(
    state.nodes.find((node) => node.id === "a")?.minimizedAtUnixMs,
    1720000000000
  );

  state = reduceWorkbenchState(state, { type: "restoreNode", nodeID: "a" });
  assert.equal(state.nodes.find((node) => node.id === "a")?.isMinimized, false);
  assert.equal(
    state.nodes.find((node) => node.id === "a")?.minimizedAtUnixMs,
    null
  );
});

test("selects the focused visible node when the stack top is minimized", () => {
  const state = createWorkbenchInitialState({
    nodes: [
      makeNode("a"),
      {
        ...makeNode("b"),
        isMinimized: true
      }
    ],
    nodeStack: ["a", "b"]
  });

  assert.equal(selectFocusedWorkbenchNode(state)?.id, "b");
  assert.equal(selectFocusedVisibleWorkbenchNode(state)?.id, "a");
});

test("keeps an already focused visible node stable", () => {
  const state = createWorkbenchInitialState({
    nodes: [makeNode("a"), makeNode("b")],
    nodeStack: ["a", "b"]
  });

  const nextState = reduceWorkbenchState(state, {
    type: "focusNode",
    nodeID: "b"
  });

  assert.equal(nextState, state);
  assert.equal(nextState.nodes, state.nodes);
  assert.equal(nextState.nodeStack, state.nodeStack);
});

test("focuses background nodes and restores minimized focused nodes", () => {
  let state = createWorkbenchInitialState({
    nodes: [makeNode("a"), makeNode("b")],
    nodeStack: ["a", "b"]
  });

  state = reduceWorkbenchState(state, { type: "focusNode", nodeID: "a" });
  assert.equal(selectFocusedWorkbenchNode(state)?.id, "a");

  state = reduceWorkbenchState(state, { type: "minimizeNode", nodeID: "a" });
  assert.equal(state.nodes.find((node) => node.id === "a")?.isMinimized, true);

  state = reduceWorkbenchState(state, { type: "focusNode", nodeID: "a" });
  assert.equal(state.nodes.find((node) => node.id === "a")?.isMinimized, false);
  assert.equal(
    state.nodes.find((node) => node.id === "a")?.minimizedAtUnixMs,
    null
  );
});

test("tracks active resize node separately from active drag node", () => {
  let state = createWorkbenchInitialState({ nodes: [makeNode("a")] });

  state = reduceWorkbenchState(state, {
    type: "setActiveDragNode",
    nodeID: "a"
  });
  state = reduceWorkbenchState(state, {
    type: "setActiveResizeNode",
    nodeID: "a"
  });

  assert.equal(state.activeDragNodeId, "a");
  assert.equal(state.activeResizeNodeId, "a");

  state = reduceWorkbenchState(state, {
    type: "setActiveResizeNode",
    nodeID: null
  });

  assert.equal(state.activeDragNodeId, "a");
  assert.equal(state.activeResizeNodeId, null);
});

test("enters and exits fullscreen with restore frame", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 600 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("a")],
    nodeStack: ["a"]
  });

  const originalFrame = state.nodes[0]?.frame;
  state = reduceWorkbenchState(state, { type: "enterFullscreen", nodeID: "a" });
  assert.equal(state.nodes[0]?.displayMode, "fullscreen");
  assert.deepEqual(state.nodes[0]?.restoreFrame, originalFrame);
  assert.deepEqual(state.nodes[0]?.frame, {
    x: 0,
    y: 52,
    width: 900,
    height: 548
  });

  state = reduceWorkbenchState(state, { type: "exitFullscreen", nodeID: "a" });
  assert.equal(state.nodes[0]?.displayMode, "floating");
  assert.deepEqual(state.nodes[0]?.frame, originalFrame);
});

test("applies quick layouts as floating focused windows", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1200, height: 800 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("a")],
    nodeStack: ["a"]
  });

  state = reduceWorkbenchState(state, { type: "enterFullscreen", nodeID: "a" });
  state = reduceWorkbenchState(state, {
    type: "applyQuickLayout",
    nodeID: "a",
    target: "right"
  });

  assert.equal(state.nodes[0]?.displayMode, "floating");
  assert.equal(state.nodes[0]?.restoreFrame, null);
  assert.equal(state.nodes[0]?.isMinimized, false);
  assert.deepEqual(state.nodes[0]?.frame, {
    x: 900,
    y: 52,
    width: 300,
    height: 684
  });
  assert.equal(selectFocusedWorkbenchNode(state)?.id, "a");
});

test("keeps dragging windows at their own size until snap is applied", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1200, height: 800 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("a")],
    nodeStack: ["a"]
  });

  state = reduceWorkbenchState(state, {
    type: "setActiveSnapTarget",
    snapTarget: "top"
  });
  state = reduceWorkbenchState(state, {
    type: "moveNode",
    nodeID: "a",
    frame: { x: 140, y: 60, width: 320, height: 220 }
  });

  assert.deepEqual(state.nodes[0]?.frame, {
    x: 140,
    y: 60,
    width: 320,
    height: 220
  });

  state = reduceWorkbenchState(state, {
    type: "applyActiveSnapTarget",
    nodeID: "a"
  });

  assert.deepEqual(state.nodes[0]?.frame, {
    x: 0,
    y: 52,
    width: 1200,
    height: 684
  });
});

test("allows dragged floating nodes to overflow while keeping them reachable", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 640 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("a", { x: 100, y: 120, width: 640, height: 420 })],
    nodeStack: ["a"]
  });

  state = reduceWorkbenchState(state, {
    type: "dragNode",
    nodeID: "a",
    frame: { x: -620, y: 700, width: 640, height: 420 }
  });

  assert.deepEqual(state.nodes[0]?.frame, {
    x: -600,
    y: 536,
    width: 640,
    height: 420
  });
});

test("applies active snap target after an overflowing drag", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 640 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("a", { x: 100, y: 120, width: 640, height: 420 })],
    nodeStack: ["a"]
  });

  state = reduceWorkbenchState(state, {
    type: "setActiveSnapTarget",
    snapTarget: "top"
  });
  state = reduceWorkbenchState(state, {
    type: "dragNode",
    nodeID: "a",
    frame: { x: -620, y: 700, width: 640, height: 420 }
  });
  state = reduceWorkbenchState(state, {
    type: "applyActiveSnapTarget",
    nodeID: "a"
  });

  assert.deepEqual(state.nodes[0]?.frame, {
    x: 0,
    y: 52,
    width: 900,
    height: 524
  });
});

test("applies an explicit snap target without activating the snap preview", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 640 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("a", { x: 100, y: 120, width: 640, height: 420 })],
    nodeStack: ["a"]
  });

  state = reduceWorkbenchState(state, {
    type: "applySnapTarget",
    nodeID: "a",
    snapTarget: "top"
  });

  assert.equal(state.activeSnapTarget, null);
  assert.deepEqual(state.nodes[0]?.frame, {
    x: 0,
    y: 52,
    width: 900,
    height: 524
  });
});

test("explicit top snap restores position even when the node is already the snap size", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 640 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("a", { x: 24, y: 88, width: 900, height: 524 })],
    nodeStack: ["a"]
  });

  state = reduceWorkbenchState(state, {
    type: "applySnapTarget",
    nodeID: "a",
    snapTarget: "top"
  });

  assert.deepEqual(state.nodes[0]?.frame, {
    x: 0,
    y: 52,
    width: 900,
    height: 524
  });
});

test("selects the foreground fullscreen node to exit before dock launch", () => {
  let state = createWorkbenchInitialState({
    nodes: [makeNode("a"), makeNode("b"), makeNode("c")],
    nodeStack: ["a", "b", "c"]
  });

  state = reduceWorkbenchState(state, { type: "enterFullscreen", nodeID: "a" });
  state = reduceWorkbenchState(state, { type: "enterFullscreen", nodeID: "b" });

  assert.equal(selectFullscreenNodeToExitBeforeDockLaunch(state, "c")?.id, "b");
  assert.equal(selectFullscreenNodeToExitBeforeDockLaunch(state, "b"), null);

  state = reduceWorkbenchState(state, { type: "minimizeNode", nodeID: "b" });
  assert.equal(selectFullscreenNodeToExitBeforeDockLaunch(state, "c")?.id, "a");
});

test("updates fullscreen and floating nodes when layout constraints change", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 600 },
    nodes: [
      makeNode("floating", { x: 8, y: 8, width: 320, height: 220 }),
      makeNode("fullscreen")
    ],
    nodeStack: ["floating", "fullscreen"]
  });

  state = reduceWorkbenchState(state, {
    type: "enterFullscreen",
    nodeID: "fullscreen"
  });
  state = reduceWorkbenchState(state, {
    type: "setLayoutConstraints",
    constraints: {
      surfacePadding: 0,
      safeArea: { top: 52, bottom: 64 }
    }
  });

  assert.deepEqual(state.nodes.find((node) => node.id === "floating")?.frame, {
    x: 8,
    y: 8,
    width: 320,
    height: 220
  });
  assert.deepEqual(
    state.nodes.find((node) => node.id === "fullscreen")?.frame,
    {
      x: 0,
      y: 52,
      width: 900,
      height: 548
    }
  );
});

test("recomputes fullscreen nodes against the bottom edge when surface size changes", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 600 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("fullscreen")],
    nodeStack: ["fullscreen"]
  });

  state = reduceWorkbenchState(state, {
    type: "enterFullscreen",
    nodeID: "fullscreen"
  });
  state = reduceWorkbenchState(state, {
    type: "setSurfaceSize",
    size: { width: 960, height: 640 }
  });

  assert.deepEqual(state.nodes[0]?.frame, {
    x: 0,
    y: 52,
    width: 960,
    height: 588
  });
});

test("preserves unchanged floating node references when surface size changes", () => {
  const state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 600 },
    nodes: [makeNode("floating")],
    nodeStack: ["floating"]
  });
  const nextState = reduceWorkbenchState(state, {
    type: "setSurfaceSize",
    size: { width: 960, height: 640 }
  });

  assert.notEqual(nextState, state);
  assert.equal(nextState.nodes, state.nodes);
  assert.equal(nextState.nodes[0], state.nodes[0]);
  assert.equal(nextState.nodes[0]?.frame, state.nodes[0]?.frame);
});

test("keeps floating nodes visible near the bottom when surface size changes", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 600 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("floating", { x: 8, y: 560, width: 320, height: 220 })],
    nodeStack: ["floating"]
  });

  state = reduceWorkbenchState(state, {
    type: "setSurfaceSize",
    size: { width: 960, height: 640 }
  });

  assert.deepEqual(state.nodes[0]?.frame, {
    x: 8,
    y: 536,
    width: 320,
    height: 220
  });
});

test("keeps offscreen floating nodes visible when surface size changes", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 900, height: 640 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [makeNode("floating", { x: -700, y: 700, width: 640, height: 420 })],
    nodeStack: ["floating"]
  });

  state = reduceWorkbenchState(state, {
    type: "setSurfaceSize",
    size: { width: 1200, height: 800 }
  });

  assert.deepEqual(state.nodes[0]?.frame, {
    x: -600,
    y: 696,
    width: 640,
    height: 420
  });
});

test("applies a batch layout preset without touching unselected nodes", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1000, height: 700 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [
      makeNode("a"),
      makeNode("b", { x: 120, y: 96, width: 360, height: 240 }),
      makeNode("c", { x: 240, y: 140, width: 420, height: 280 }),
      makeNode("d", { x: 640, y: 180, width: 320, height: 220 })
    ],
    nodeStack: ["a", "b", "c", "d"]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "c", "b"],
    preset: { kind: "balanced" }
  });

  assert.deepEqual(state.nodes.find((node) => node.id === "a")?.frame, {
    x: 0,
    y: 52,
    width: 573,
    height: 584
  });
  assert.deepEqual(state.nodes.find((node) => node.id === "c")?.frame, {
    x: 585,
    y: 52,
    width: 415,
    height: 286
  });
  assert.deepEqual(state.nodes.find((node) => node.id === "b")?.frame, {
    x: 585,
    y: 350,
    width: 415,
    height: 286
  });
  assert.deepEqual(state.nodes.find((node) => node.id === "d")?.frame, {
    x: 640,
    y: 180,
    width: 320,
    height: 220
  });
  assert.deepEqual(state.nodeStack.slice(-3), ["a", "c", "b"]);
});

test("applies a visible layout preset without restoring minimized nodes", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1000, height: 700 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [
      makeNode("a"),
      makeNode("b", { x: 120, y: 96, width: 360, height: 240 }),
      {
        ...makeNode("c", { x: 240, y: 140, width: 420, height: 280 }),
        isMinimized: true,
        minimizedAtUnixMs: 1720000000000
      }
    ],
    nodeStack: ["a", "b", "c"]
  });

  state = reduceWorkbenchState(state, {
    type: "applyVisibleLayoutPreset",
    preset: { kind: "row" }
  });

  assert.deepEqual(state.nodes.find((node) => node.id === "a")?.frame, {
    x: 0,
    y: 52,
    width: 494,
    height: 584
  });
  assert.deepEqual(state.nodes.find((node) => node.id === "b")?.frame, {
    x: 506,
    y: 52,
    width: 494,
    height: 584
  });
  assert.deepEqual(state.nodes.find((node) => node.id === "c")?.frame, {
    x: 240,
    y: 140,
    width: 420,
    height: 280
  });
  assert.equal(state.nodes.find((node) => node.id === "c")?.isMinimized, true);
  assert.deepEqual(state.nodeStack.slice(-2), ["a", "b"]);
});

test("enforces node size constraints when resizing and updating constraints", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1200, height: 800 },
    layoutConstraints: {
      minWidth: 220,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
    },
    nodes: [
      makeNode(
        "a",
        { x: 80, y: 80, width: 760, height: 540 },
        {
          minHeight: 520,
          minWidth: 720
        }
      )
    ],
    nodeStack: ["a"]
  });

  state = reduceWorkbenchState(state, {
    type: "resizeNode",
    nodeID: "a",
    frame: { x: 80, y: 80, width: 320, height: 220 }
  });

  assert.deepEqual(state.nodes[0]?.frame, {
    x: 80,
    y: 80,
    width: 720,
    height: 520
  });

  state = reduceWorkbenchState(state, {
    type: "setNodeSizeConstraints",
    nodeID: "a",
    sizeConstraints: { minHeight: 600, minWidth: 840 }
  });

  assert.deepEqual(state.nodes[0]?.sizeConstraints, {
    minHeight: 600,
    minWidth: 840
  });
  assert.deepEqual(state.nodes[0]?.frame, {
    x: 80,
    y: 80,
    width: 840,
    height: 600
  });
});

test("preserves state object on no-op actions", () => {
  const state = createWorkbenchInitialState({ nodes: [makeNode("a")] });
  assert.equal(
    reduceWorkbenchState(state, { type: "closeNode", nodeID: "missing" }),
    state
  );
});

test("replaces nodes and stack together", () => {
  const state = createWorkbenchInitialState({
    nodes: [makeNode("a")],
    nodeStack: ["a"]
  });
  const next = reduceWorkbenchState(state, {
    type: "replaceState",
    state: {
      nodes: [makeNode("b"), makeNode("c")],
      nodeStack: ["c", "b"]
    }
  });

  assert.deepEqual(
    next.nodes.map((node) => node.id),
    ["b", "c"]
  );
  assert.deepEqual(next.nodeStack, ["c", "b"]);
});

test("replaceState preserves existing layout constraints when omitted", () => {
  let state = createWorkbenchInitialState();
  state = reduceWorkbenchState(state, {
    type: "setLayoutConstraints",
    constraints: { surfacePadding: 0, safeArea: { top: 52, bottom: 64 } }
  });

  const next = reduceWorkbenchState(state, {
    type: "replaceState",
    state: { nodes: [makeNode("a")], nodeStack: ["a"] }
  });

  assert.deepEqual(next.layoutConstraints.safeArea, {
    top: 52,
    right: 0,
    bottom: 64,
    left: 0
  });
});

test("replaceState can update layout constraints", () => {
  const state = createWorkbenchInitialState();

  const next = reduceWorkbenchState(state, {
    type: "replaceState",
    state: {
      layoutConstraints: {
        minWidth: 280,
        minHeight: 180,
        surfacePadding: 0,
        safeArea: { top: 52, right: 0, bottom: 72, left: 0 }
      }
    }
  });

  assert.notEqual(next, state);
  assert.equal(next.layoutConstraints.minWidth, 280);
  assert.deepEqual(next.layoutConstraints.safeArea, {
    top: 52,
    right: 0,
    bottom: 72,
    left: 0
  });
});

test("applyLayoutPreset without lock does not remember the layout", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" }
  });

  assert.equal(state.lockedLayout, null);
});

test("locked layout re-applies proportionally on surface resize", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });

  assert.deepEqual(state.lockedLayout, {
    preset: { kind: "row" },
    nodeIDs: ["a", "b"]
  });

  const lockedFrames = state.nodes.map((node) => ({ ...node.frame }));

  state = reduceWorkbenchState(state, {
    type: "setSurfaceSize",
    size: { width: 1440, height: 900 }
  });

  // Lock survives the resize and the frames grow with the larger surface.
  assert.deepEqual(state.lockedLayout, {
    preset: { kind: "row" },
    nodeIDs: ["a", "b"]
  });
  const resizedFrames = state.nodes.map((node) => node.frame);
  const firstLocked = lockedFrames[0]!;
  const firstResized = resizedFrames[0]!;
  const secondResized = resizedFrames[1]!;
  assert.ok(
    firstResized.width > firstLocked.width,
    "columns should widen with the surface"
  );
  // Row preset keeps the two nodes side-by-side spanning the surface.
  assert.equal(firstResized.y, secondResized.y);
});

test("manual move releases a locked layout", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });
  assert.notEqual(state.lockedLayout, null);

  state = reduceWorkbenchState(state, {
    type: "moveNode",
    nodeID: "a",
    frame: { x: 300, y: 300, width: 320, height: 220 }
  });

  assert.equal(state.lockedLayout, null);
});

test("dragging a locked node keeps the lock and settles into a slot swap", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });

  const slotA = { ...state.nodes.find((node) => node.id === "a")!.frame };
  const slotB = { ...state.nodes.find((node) => node.id === "b")!.frame };

  // Drag "a" so its center lands inside "b"'s slot: lock must survive.
  state = reduceWorkbenchState(state, {
    type: "dragNode",
    nodeID: "a",
    frame: { ...slotA, x: slotB.x + 10, y: slotB.y + 10 }
  });
  assert.notEqual(state.lockedLayout, null);

  state = reduceWorkbenchState(state, {
    type: "settleLockedDrag",
    nodeID: "a"
  });

  // The two nodes swapped slots and the lock now tracks the new order.
  assert.deepEqual(state.nodes.find((node) => node.id === "a")?.frame, slotB);
  assert.deepEqual(state.nodes.find((node) => node.id === "b")?.frame, slotA);
  assert.deepEqual(state.lockedLayout, {
    preset: { kind: "row" },
    nodeIDs: ["b", "a"]
  });
});

test("settling a locked drag with no target snaps the node back", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });

  const slotA = { ...state.nodes.find((node) => node.id === "a")!.frame };

  // Nudge "a" slightly; its center stays inside its own slot.
  state = reduceWorkbenchState(state, {
    type: "dragNode",
    nodeID: "a",
    frame: { ...slotA, x: slotA.x + 12, y: slotA.y + 12 }
  });
  state = reduceWorkbenchState(state, {
    type: "settleLockedDrag",
    nodeID: "a"
  });

  assert.deepEqual(state.nodes.find((node) => node.id === "a")?.frame, slotA);
  assert.deepEqual(state.lockedLayout, {
    preset: { kind: "row" },
    nodeIDs: ["a", "b"]
  });
});

test("moveLockedNode swaps slots with the neighbor in the direction", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });

  const slotA = { ...state.nodes.find((node) => node.id === "a")!.frame };
  const slotB = { ...state.nodes.find((node) => node.id === "b")!.frame };

  // "a" sits in the left slot; moving right swaps with "b".
  state = reduceWorkbenchState(state, {
    type: "moveLockedNode",
    nodeID: "a",
    direction: "right"
  });

  assert.deepEqual(state.nodes.find((node) => node.id === "a")?.frame, slotB);
  assert.deepEqual(state.nodes.find((node) => node.id === "b")?.frame, slotA);
  assert.deepEqual(state.lockedLayout, {
    preset: { kind: "row" },
    nodeIDs: ["b", "a"]
  });

  // Moving right again is a no-op: no slot exists to the right of "a".
  const settled = reduceWorkbenchState(state, {
    type: "moveLockedNode",
    nodeID: "a",
    direction: "right"
  });
  assert.equal(settled, state);

  // Moving back left restores the original arrangement.
  state = reduceWorkbenchState(state, {
    type: "moveLockedNode",
    nodeID: "a",
    direction: "left"
  });
  assert.deepEqual(state.nodes.find((node) => node.id === "a")?.frame, slotA);
  assert.deepEqual(state.lockedLayout?.nodeIDs, ["a", "b"]);
});

test("moveLockedNode swaps vertically inside a balanced layout", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b"), makeNode("c")]
  });

  // Balanced 3-window layout: "a" fills the left column, "b" (top) and "c"
  // (bottom) stack in the right column.
  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b", "c"],
    preset: { kind: "balanced" },
    lock: true
  });

  const slotB = { ...state.nodes.find((node) => node.id === "b")!.frame };
  const slotC = { ...state.nodes.find((node) => node.id === "c")!.frame };
  assert.ok(slotB.y < slotC.y, "expected b above c in the right column");

  state = reduceWorkbenchState(state, {
    type: "moveLockedNode",
    nodeID: "b",
    direction: "down"
  });

  assert.deepEqual(state.nodes.find((node) => node.id === "b")?.frame, slotC);
  assert.deepEqual(state.nodes.find((node) => node.id === "c")?.frame, slotB);
  assert.notEqual(state.lockedLayout, null);
});

test("opening a window while locked adds a slot to the locked grid", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });

  state = reduceWorkbenchState(state, {
    type: "openNode",
    node: makeNode("c", { x: 400, y: 300, width: 320, height: 220 })
  });

  assert.deepEqual(state.lockedLayout, {
    preset: { kind: "row" },
    nodeIDs: ["a", "b", "c"]
  });
  // All three windows now tile the row: same y/height, disjoint columns.
  const frames = ["a", "b", "c"].map(
    (id) => state.nodes.find((node) => node.id === id)!.frame
  );
  assert.equal(new Set(frames.map((frame) => frame.y)).size, 1);
  assert.equal(new Set(frames.map((frame) => frame.x)).size, 3);
  assert.notDeepEqual(frames[2], { x: 400, y: 300, width: 320, height: 220 });
});

test("opening a window that does not fit keeps the lock and floats", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b"), makeNode("c")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b", "c"],
    preset: { kind: "row" },
    lock: true
  });
  const lockedFrames = state.nodes.map((node) => node.frame);

  // A fourth 280px-min column cannot fit into 1024px: the new window floats
  // and the existing lock stays untouched.
  const floatFrame = { x: 200, y: 200, width: 320, height: 220 };
  state = reduceWorkbenchState(state, {
    type: "openNode",
    node: makeNode("d", floatFrame)
  });

  assert.deepEqual(state.lockedLayout, {
    preset: { kind: "row" },
    nodeIDs: ["a", "b", "c"]
  });
  assert.deepEqual(
    state.nodes.slice(0, 3).map((node) => node.frame),
    lockedFrames
  );
  assert.deepEqual(
    state.nodes.find((node) => node.id === "d")?.frame,
    floatFrame
  );
});

test("resizing a locked node moves the shared divider and keeps the lock", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });

  const slotA = { ...state.nodes.find((node) => node.id === "a")!.frame };
  const slotB = { ...state.nodes.find((node) => node.id === "b")!.frame };
  const gap = slotB.x - (slotA.x + slotA.width);

  // Drag "a"'s east handle 100px to the right.
  state = reduceWorkbenchState(state, {
    type: "resizeNode",
    nodeID: "a",
    frame: { ...slotA, width: slotA.width + 100 }
  });

  const resizedA = state.nodes.find((node) => node.id === "a")!.frame;
  const resizedB = state.nodes.find((node) => node.id === "b")!.frame;
  assert.equal(resizedA.width, slotA.width + 100);
  assert.equal(resizedB.x, slotB.x + 100);
  assert.equal(resizedB.width, slotB.width - 100);
  // The gap between the two slots is preserved.
  assert.equal(resizedB.x - (resizedA.x + resizedA.width), gap);
  // The lock survives and now carries custom slot geometry.
  assert.notEqual(state.lockedLayout, null);
  assert.ok(state.lockedLayout?.normalizedFrames);
});

test("a custom locked grid scales proportionally on surface resize", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });
  const slotA = { ...state.nodes.find((node) => node.id === "a")!.frame };
  state = reduceWorkbenchState(state, {
    type: "resizeNode",
    nodeID: "a",
    frame: { ...slotA, width: slotA.width + 100 }
  });

  const customA = state.nodes.find((node) => node.id === "a")!.frame;
  const customB = state.nodes.find((node) => node.id === "b")!.frame;
  const ratio = customA.width / customB.width;

  state = reduceWorkbenchState(state, {
    type: "setSurfaceSize",
    size: { width: 2048, height: 720 }
  });

  const scaledA = state.nodes.find((node) => node.id === "a")!.frame;
  const scaledB = state.nodes.find((node) => node.id === "b")!.frame;
  // Both widths grew and the custom ratio (not the preset 1:1) is preserved.
  assert.ok(scaledA.width > customA.width);
  assert.ok(scaledB.width > customB.width);
  assert.ok(Math.abs(scaledA.width / scaledB.width - ratio) < 0.05);
  assert.ok(state.lockedLayout?.normalizedFrames);
});

test("locked divider resize clamps to the neighbor's minimum size", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });
  const slotA = { ...state.nodes.find((node) => node.id === "a")!.frame };

  // Try to push the divider far past "b"'s minimum width.
  state = reduceWorkbenchState(state, {
    type: "resizeNode",
    nodeID: "a",
    frame: { ...slotA, width: slotA.width + 10_000 }
  });

  const clampedB = state.nodes.find((node) => node.id === "b")!.frame;
  assert.equal(clampedB.width, 280);
  assert.notEqual(state.lockedLayout, null);
});

test("swapping slots keeps custom grid geometry with the slot", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });
  const slotA = { ...state.nodes.find((node) => node.id === "a")!.frame };
  state = reduceWorkbenchState(state, {
    type: "resizeNode",
    nodeID: "a",
    frame: { ...slotA, width: slotA.width + 100 }
  });
  const customA = { ...state.nodes.find((node) => node.id === "a")!.frame };
  const customB = { ...state.nodes.find((node) => node.id === "b")!.frame };

  state = reduceWorkbenchState(state, {
    type: "moveLockedNode",
    nodeID: "a",
    direction: "right"
  });

  // "a" now owns the (narrower) right slot, "b" the wider left slot.
  assert.deepEqual(state.nodes.find((node) => node.id === "a")?.frame, customB);
  assert.deepEqual(state.nodes.find((node) => node.id === "b")?.frame, customA);
});

test("resizing a locked node's outer edge does not break the grid", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });
  const slotA = { ...state.nodes.find((node) => node.id === "a")!.frame };

  // Dragging "a"'s west handle (layout-rect boundary) is a no-op.
  const next = reduceWorkbenchState(state, {
    type: "resizeNode",
    nodeID: "a",
    frame: {
      ...slotA,
      x: slotA.x + 80,
      width: slotA.width - 80
    }
  });

  assert.equal(next, state);
});

test("releaseLockedLayout clears the lock without moving nodes", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b"],
    preset: { kind: "row" },
    lock: true
  });
  const framesBefore = state.nodes.map((node) => node.frame);

  state = reduceWorkbenchState(state, { type: "releaseLockedLayout" });

  assert.equal(state.lockedLayout, null);
  assert.deepEqual(
    state.nodes.map((node) => node.frame),
    framesBefore
  );
});

test("closing a locked node drops the lock below two nodes", () => {
  let state = createWorkbenchInitialState({
    surfaceSize: { width: 1024, height: 720 },
    nodes: [makeNode("a"), makeNode("b"), makeNode("c")]
  });

  state = reduceWorkbenchState(state, {
    type: "applyLayoutPreset",
    nodeIDs: ["a", "b", "c"],
    preset: { kind: "row" },
    lock: true
  });

  state = reduceWorkbenchState(state, { type: "closeNode", nodeID: "c" });
  assert.deepEqual(state.lockedLayout, {
    preset: { kind: "row" },
    nodeIDs: ["a", "b"]
  });

  state = reduceWorkbenchState(state, { type: "closeNode", nodeID: "b" });
  assert.equal(state.lockedLayout, null);
});

function makeNode(
  id: string,
  frame: WorkbenchNode["frame"] = { x: 32, y: 32, width: 320, height: 220 },
  sizeConstraints: WorkbenchNode["sizeConstraints"] = null
): WorkbenchNode {
  return {
    id,
    kind: "test",
    title: id,
    frame,
    displayMode: "floating",
    restoreFrame: null,
    isMinimized: false,
    sizeConstraints,
    data: null
  };
}
