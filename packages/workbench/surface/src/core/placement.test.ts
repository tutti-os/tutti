import assert from "node:assert/strict";
import test from "node:test";
import {
  clampWorkbenchDragRect,
  clampWorkbenchRect,
  clampWorkbenchRectToVisibleArea,
  getWorkbenchLayoutFrame,
  getWorkbenchLayoutPresetFrames,
  getWorkbenchFullscreenRect,
  getWorkbenchQuickLayoutRect,
  getWorkbenchSnapRect,
  inferWorkbenchSnapTarget
} from "./geometry.ts";
import {
  createWorkbenchInitialRect,
  resolveWorkbenchCascadedRect
} from "./placement.ts";

test("clamps rects to surface bounds and minimum size", () => {
  assert.deepEqual(
    clampWorkbenchRect(
      { x: -100, y: -100, width: 20, height: 20 },
      { width: 500, height: 400 }
    ),
    { x: 0, y: 52, width: 280, height: 160 }
  );
});

test("computes fullscreen and snap rects", () => {
  const size = { width: 1000, height: 700 };
  assert.deepEqual(getWorkbenchFullscreenRect(size), {
    x: 0,
    y: 52,
    width: 1000,
    height: 648
  });
  assert.deepEqual(getWorkbenchSnapRect("left", size), {
    x: 0,
    y: 52,
    width: 500,
    height: 560
  });
  assert.deepEqual(getWorkbenchSnapRect("top", size), {
    x: 0,
    y: 52,
    width: 1000,
    height: 560
  });
  assert.deepEqual(getWorkbenchQuickLayoutRect("top", size), {
    x: 0,
    y: 52,
    width: 1000,
    height: 280
  });
  assert.deepEqual(
    getWorkbenchLayoutPresetFrames(3, { kind: "balanced" }, size),
    [
      { x: 0, y: 52, width: 573, height: 560 },
      { x: 585, y: 52, width: 415, height: 274 },
      { x: 585, y: 338, width: 415, height: 274 }
    ]
  );
});

test("respects safe areas for layout, fullscreen, snap, and clamping", () => {
  const constraints = {
    minWidth: 220,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
  };
  const size = { width: 1000, height: 700 };

  assert.deepEqual(getWorkbenchLayoutFrame(size, constraints), {
    x: 0,
    y: 52,
    width: 1000,
    height: 584
  });
  assert.deepEqual(getWorkbenchFullscreenRect(size, constraints), {
    x: 0,
    y: 52,
    width: 1000,
    height: 648
  });
  assert.deepEqual(getWorkbenchSnapRect("right", size, constraints), {
    x: 500,
    y: 52,
    width: 500,
    height: 584
  });
  assert.deepEqual(getWorkbenchSnapRect("top", size, constraints), {
    x: 0,
    y: 52,
    width: 1000,
    height: 584
  });
  assert.deepEqual(getWorkbenchQuickLayoutRect("right", size, constraints), {
    x: 750,
    y: 52,
    width: 250,
    height: 584
  });
  assert.deepEqual(getWorkbenchQuickLayoutRect("top", size, constraints), {
    x: 0,
    y: 52,
    width: 1000,
    height: 292
  });
  assert.deepEqual(getWorkbenchQuickLayoutRect("bottom", size, constraints), {
    x: 0,
    y: 344,
    width: 1000,
    height: 292
  });
  assert.deepEqual(
    clampWorkbenchRect(
      { x: -100, y: -100, width: 400, height: 260 },
      size,
      constraints
    ),
    { x: 0, y: 52, width: 400, height: 260 }
  );
});

test("keeps top snap inside the normal safe layout while fullscreen ignores dock safe areas", () => {
  const constraints = {
    minWidth: 220,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: { top: 52, right: 0, bottom: 64, left: 96 }
  };
  const size = { width: 1000, height: 700 };

  assert.deepEqual(getWorkbenchSnapRect("top", size, constraints), {
    x: 96,
    y: 52,
    width: 904,
    height: 584
  });
  assert.deepEqual(getWorkbenchFullscreenRect(size, constraints), {
    x: 0,
    y: 52,
    width: 1000,
    height: 648
  });
});

test("returns null when a layout preset cannot fit within minimum window bounds", () => {
  const constraints = {
    minWidth: 220,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
  };

  assert.equal(
    getWorkbenchLayoutPresetFrames(
      4,
      { kind: "row" },
      { width: 700, height: 640 },
      constraints
    ),
    null
  );
});

test("balances nine layout preset windows into a fitting grid", () => {
  const frames = getWorkbenchLayoutPresetFrames(
    9,
    { kind: "balanced" },
    { width: 1000, height: 700 }
  );

  assert.deepEqual(frames, [
    { x: 1, y: 53, width: 325, height: 178 },
    { x: 338, y: 53, width: 325, height: 178 },
    { x: 675, y: 53, width: 325, height: 178 },
    { x: 1, y: 243, width: 325, height: 178 },
    { x: 338, y: 243, width: 325, height: 178 },
    { x: 675, y: 243, width: 325, height: 178 },
    { x: 1, y: 433, width: 325, height: 178 },
    { x: 338, y: 433, width: 325, height: 178 },
    { x: 675, y: 433, width: 325, height: 178 }
  ]);
});

test("infers drag snap only after the pointer crosses into the top safe area", () => {
  const constraints = {
    minWidth: 220,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
  };
  const size = { width: 1000, height: 700 };

  assert.equal(
    inferWorkbenchSnapTarget({ y: 84 }, size, undefined, constraints),
    null
  );
  assert.equal(
    inferWorkbenchSnapTarget({ y: 52 }, size, undefined, constraints),
    null
  );
  assert.equal(
    inferWorkbenchSnapTarget({ y: 51 }, size, undefined, constraints),
    "top"
  );
  assert.equal(
    inferWorkbenchSnapTarget({ y: 400 }, size, undefined, constraints),
    null
  );
  assert.equal(
    inferWorkbenchSnapTarget({ y: 400 }, size, undefined, constraints),
    null
  );
});

test("allows floating rects to overflow while keeping a visible safety strip", () => {
  const constraints = {
    minWidth: 220,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
  };
  const size = { width: 900, height: 640 };

  assert.deepEqual(
    clampWorkbenchRectToVisibleArea(
      { x: -620, y: -360, width: 640, height: 420 },
      size,
      constraints
    ),
    { x: -600, y: -328, width: 640, height: 420 }
  );

  assert.deepEqual(
    clampWorkbenchRectToVisibleArea(
      { x: 880, y: 700, width: 640, height: 420 },
      size,
      constraints
    ),
    { x: 860, y: 536, width: 640, height: 420 }
  );
});

test("keeps drag rects below the top safe area while allowing side overflow", () => {
  const constraints = {
    minWidth: 220,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: { top: 52, right: 0, bottom: 64, left: 0 }
  };
  const size = { width: 900, height: 640 };

  assert.deepEqual(
    clampWorkbenchDragRect(
      { x: -620, y: -360, width: 640, height: 420 },
      size,
      constraints
    ),
    { x: -600, y: 52, width: 640, height: 420 }
  );
});

test("creates staggered initial rects", () => {
  const first = createWorkbenchInitialRect(0, { width: 1200, height: 800 });
  const second = createWorkbenchInitialRect(1, { width: 1200, height: 800 });

  assert.notDeepEqual(first, second);
  assert.equal(second.x - first.x, 28);
});

test("cascades the next rect from the active node", () => {
  assert.deepEqual(
    resolveWorkbenchCascadedRect({
      currentNodeStack: ["node-a", "node-b"],
      existingNodes: [
        {
          id: "node-a",
          kind: "files",
          title: "Node A",
          frame: { x: 100, y: 80, width: 640, height: 420 },
          displayMode: "floating",
          restoreFrame: null,
          isMinimized: false,
          data: null
        },
        {
          id: "node-b",
          kind: "browser",
          title: "Node B",
          frame: { x: 220, y: 140, width: 760, height: 520 },
          displayMode: "floating",
          restoreFrame: null,
          isMinimized: false,
          data: null
        }
      ],
      preferredFrame: { x: 0, y: 0, width: 900, height: 560 },
      surfaceSize: { width: 1440, height: 900 }
    }),
    { x: 248, y: 168, width: 900, height: 560 }
  );
});
