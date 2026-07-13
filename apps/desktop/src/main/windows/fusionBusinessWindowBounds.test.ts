import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyFusionBusinessWindowBoundsState,
  createFusionBusinessWindowBoundsKey,
  readFusionBusinessWindowBounds,
  resolveFusionBusinessWindowBounds,
  resolveFusionBusinessWindowMinimumSize,
  writeFusionBusinessWindowBounds
} from "./fusionBusinessWindowBounds.ts";

const primaryDisplay = {
  id: 1,
  workArea: { height: 900, width: 1440, x: 0, y: 24 }
};
const secondaryDisplay = {
  id: 2,
  workArea: { height: 1000, width: 1600, x: 1440, y: 0 }
};

test("Fusion business bounds use workspace-scoped kind and resource identity", () => {
  assert.notEqual(
    createFusionBusinessWindowBoundsKey({
      kind: "terminal",
      resourceId: "terminal-1",
      workspaceId: "workspace-1"
    }),
    createFusionBusinessWindowBoundsKey({
      kind: "terminal",
      resourceId: "terminal-1",
      workspaceId: "workspace-2"
    })
  );
});

test("Fusion business bounds restore size and placement on the saved display", () => {
  assert.deepEqual(
    resolveFusionBusinessWindowBounds({
      defaultBounds: { height: 760, width: 1100, x: 100, y: 100 },
      displays: [primaryDisplay, secondaryDisplay],
      persisted: {
        displayId: 2,
        height: 680,
        updatedAtUnixMs: 1,
        width: 980,
        x: 1700,
        y: 120
      },
      primaryDisplay
    }),
    { displayId: 2, height: 680, width: 980, x: 1700, y: 120 }
  );
});

test("Fusion business bounds clamp to the primary work area after display unplug", () => {
  assert.deepEqual(
    resolveFusionBusinessWindowBounds({
      defaultBounds: { height: 760, width: 1100, x: 100, y: 100 },
      displays: [primaryDisplay],
      persisted: {
        displayId: 2,
        height: 1200,
        updatedAtUnixMs: 1,
        width: 1800,
        x: 1800,
        y: -200
      },
      primaryDisplay
    }),
    { displayId: 1, height: 900, width: 1440, x: 0, y: 24 }
  );
});

test("explicit new Fusion windows cascade without leaving the work area", () => {
  const persisted = {
    displayId: 1,
    height: 700,
    updatedAtUnixMs: 1,
    width: 1000,
    x: 100,
    y: 100
  };
  const firstCascade = resolveFusionBusinessWindowBounds({
    cascade: true,
    defaultBounds: persisted,
    displays: [primaryDisplay],
    occupiedBounds: [persisted],
    persisted,
    primaryDisplay
  });
  const secondCascade = resolveFusionBusinessWindowBounds({
    cascade: true,
    defaultBounds: persisted,
    displays: [primaryDisplay],
    occupiedBounds: [persisted, firstCascade],
    persisted,
    primaryDisplay
  });

  assert.deepEqual(firstCascade, {
    displayId: 1,
    height: 700,
    width: 1000,
    x: 128,
    y: 128
  });
  assert.deepEqual(secondCascade, {
    displayId: 1,
    height: 700,
    width: 1000,
    x: 156,
    y: 156
  });
});

test("resource restore falls back to its kind placement until it has exact bounds", () => {
  const kindBounds = {
    displayId: 1,
    height: 700,
    updatedAtUnixMs: 1,
    width: 1000,
    x: 80,
    y: 90
  };
  const state = writeFusionBusinessWindowBounds(
    createEmptyFusionBusinessWindowBoundsState(),
    { kind: "terminal", resourceId: null, workspaceId: "workspace-1" },
    kindBounds
  );
  assert.equal(
    readFusionBusinessWindowBounds(state, {
      kind: "terminal",
      resourceId: "terminal-1",
      workspaceId: "workspace-1"
    }),
    kindBounds
  );
});

test("Fusion business window minimum size contracts to a narrow work area", () => {
  assert.deepEqual(
    resolveFusionBusinessWindowMinimumSize({
      configured: { height: 640, width: 960 },
      workArea: { height: 600, width: 800 }
    }),
    { height: 600, width: 800 }
  );
  assert.deepEqual(
    resolveFusionBusinessWindowMinimumSize({
      configured: { height: 640, width: 960 },
      workArea: { height: 900, width: 1440 }
    }),
    { height: 640, width: 960 }
  );
});
