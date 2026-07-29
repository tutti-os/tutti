import assert from "node:assert/strict";
import test from "node:test";
import {
  selectVisuallyExposedWorkbenchNodeIDs,
  selectWorkbenchNodeIsVisuallyExposed
} from "./visualOcclusion.ts";
import {
  defaultWorkbenchLayoutConstraints,
  type WorkbenchFrame,
  type WorkbenchNode,
  type WorkbenchState
} from "./types.ts";

test("keeps fully and partially exposed windows visible", () => {
  const state = workbenchState([
    node("hidden-1", frame(0, 0)),
    node("hidden-2", frame(0, 0)),
    node("hidden-3", frame(0, 0)),
    node("hidden-4", frame(0, 0)),
    node("partial-right", frame(80, 0)),
    node("partial-bottom", frame(0, 80)),
    node("visible-a", frame(0, 0)),
    node("visible-b", frame(300, 0)),
    node("visible-c", frame(0, 300)),
    node("visible-d", frame(300, 300))
  ]);

  assert.deepEqual([...selectVisuallyExposedWorkbenchNodeIDs(state)].sort(), [
    "partial-bottom",
    "partial-right",
    "visible-a",
    "visible-b",
    "visible-c",
    "visible-d"
  ]);
});

test("treats the union of higher windows as full occlusion", () => {
  const state = workbenchState([
    node("covered", frame(0, 0, 200, 100)),
    node("left-cover", frame(0, 0)),
    node("right-cover", frame(100, 0))
  ]);

  assert.equal(selectWorkbenchNodeIsVisuallyExposed(state, "covered"), false);
  assert.equal(selectWorkbenchNodeIsVisuallyExposed(state, "left-cover"), true);
});

test("clips visibility to the Workbench surface and ignores minimized covers", () => {
  const minimizedCover = node("minimized-cover", frame(0, 0));
  minimizedCover.isMinimized = true;
  const state = workbenchState([
    node("offscreen", frame(700, 0)),
    node("onscreen", frame(550, 0)),
    minimizedCover
  ]);

  assert.equal(selectWorkbenchNodeIsVisuallyExposed(state, "offscreen"), false);
  assert.equal(selectWorkbenchNodeIsVisuallyExposed(state, "onscreen"), true);
  assert.equal(
    selectWorkbenchNodeIsVisuallyExposed(state, "minimized-cover"),
    false
  );
});

test("ignores a transiently hidden Genie window as an occluder", () => {
  const state = workbenchState([
    node("covered", frame(0, 0)),
    node("genie-minimizing", frame(0, 0))
  ]);
  const hiddenNodeIDs = new Set(["genie-minimizing"]);
  const presentation = {
    hiddenNodeIDs,
    nonOccludingNodeIDs: hiddenNodeIDs,
    topLayerNodeIDs: []
  };

  assert.equal(
    selectWorkbenchNodeIsVisuallyExposed(state, "covered", presentation),
    true
  );
  assert.equal(
    selectWorkbenchNodeIsVisuallyExposed(
      state,
      "genie-minimizing",
      presentation
    ),
    false
  );
});

test("keeps a transitioning window visible without letting it cover others", () => {
  const state = workbenchState([
    node("covered", frame(0, 0)),
    node("transitioning-cover", frame(0, 0))
  ]);
  const presentation = {
    hiddenNodeIDs: new Set<string>(),
    nonOccludingNodeIDs: new Set(["transitioning-cover"]),
    topLayerNodeIDs: []
  };

  assert.equal(
    selectWorkbenchNodeIsVisuallyExposed(state, "covered", presentation),
    true
  );
  assert.equal(
    selectWorkbenchNodeIsVisuallyExposed(
      state,
      "transitioning-cover",
      presentation
    ),
    true
  );
});

test("orders dialog popover windows above the default window layer", () => {
  const state = workbenchState([
    node("dialog-cover", frame(0, 0)),
    node("covered", frame(0, 0))
  ]);
  const presentation = {
    hiddenNodeIDs: new Set<string>(),
    nonOccludingNodeIDs: new Set<string>(),
    topLayerNodeIDs: ["dialog-cover"]
  };

  assert.equal(
    selectWorkbenchNodeIsVisuallyExposed(state, "covered", presentation),
    false
  );
  assert.equal(
    selectWorkbenchNodeIsVisuallyExposed(state, "dialog-cover", presentation),
    true
  );
});

test("reuses exposure when only non-geometric Workbench state changes", () => {
  const state = workbenchState([
    node("covered", frame(0, 0)),
    node("cover", frame(0, 0))
  ]);
  const exposed = selectVisuallyExposedWorkbenchNodeIDs(state);

  const nextState = {
    ...state,
    activeDragNodeId: "cover",
    activeSnapTarget: "left" as const
  };

  assert.strictEqual(selectVisuallyExposedWorkbenchNodeIDs(nextState), exposed);
});

test("reuses exposure across data-only node replacements", () => {
  const state = workbenchState([
    node("covered", frame(0, 0)),
    node("cover", frame(0, 0))
  ]);
  const exposed = selectVisuallyExposedWorkbenchNodeIDs(state);

  const nextState = {
    ...state,
    nodes: state.nodes.map((candidate) => ({
      ...candidate,
      data: { revision: 1 }
    }))
  };

  assert.strictEqual(selectVisuallyExposedWorkbenchNodeIDs(nextState), exposed);
});

test("invalidates exposure when node geometry changes", () => {
  const state = workbenchState([
    node("covered", frame(0, 0)),
    node("cover", frame(0, 0))
  ]);
  const exposed = selectVisuallyExposedWorkbenchNodeIDs(state);
  const nextState = {
    ...state,
    nodes: state.nodes.map((candidate) =>
      candidate.id === "cover"
        ? { ...candidate, frame: frame(300, 0) }
        : candidate
    )
  };
  const nextExposed = selectVisuallyExposedWorkbenchNodeIDs(nextState);

  assert.notStrictEqual(nextExposed, exposed);
  assert.equal(nextExposed.has("covered"), true);
});

function workbenchState(nodes: WorkbenchNode[]): WorkbenchState {
  return {
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    layoutConstraints: defaultWorkbenchLayoutConstraints,
    lockedLayout: null,
    nodes,
    nodeStack: nodes.map((candidate) => candidate.id),
    surfaceSize: { width: 600, height: 600 }
  };
}

function node(id: string, nodeFrame: WorkbenchFrame): WorkbenchNode {
  return {
    data: null,
    displayMode: "floating",
    frame: nodeFrame,
    id,
    isMinimized: false,
    kind: "test",
    restoreFrame: null,
    title: id
  };
}

function frame(
  x: number,
  y: number,
  width = 100,
  height = 100
): WorkbenchFrame {
  return { height, width, x, y };
}
