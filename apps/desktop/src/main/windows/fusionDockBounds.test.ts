import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFusionDockBounds,
  resolveFusionDockWidthTransition
} from "./fusionDockBounds.ts";

const primaryDisplay = {
  id: 1,
  workArea: { height: 900, width: 1440, x: 0, y: 24 }
};

test("resolveFusionDockBounds places a new dock at the primary display left center", () => {
  assert.deepEqual(
    resolveFusionDockBounds({
      defaultHeight: 520,
      defaultWidth: 380,
      displays: [primaryDisplay],
      margin: 20,
      primaryDisplay
    }),
    { displayId: 1, height: 520, width: 380, x: 20, y: 214 }
  );
});

test("resolveFusionDockBounds restores and clamps persisted bounds", () => {
  assert.deepEqual(
    resolveFusionDockBounds({
      defaultHeight: 520,
      defaultWidth: 380,
      displays: [primaryDisplay],
      margin: 20,
      persisted: {
        displayId: 1,
        height: 520,
        width: 88,
        x: 9_000,
        y: -100
      },
      primaryDisplay
    }),
    { displayId: 1, height: 520, width: 380, x: 1060, y: 24 }
  );
});

test("resolveFusionDockBounds falls back to the primary display after unplug", () => {
  assert.equal(
    resolveFusionDockBounds({
      defaultHeight: 520,
      defaultWidth: 380,
      displays: [primaryDisplay],
      margin: 20,
      persisted: {
        displayId: 2,
        height: 520,
        width: 88,
        x: 2_000,
        y: 200
      },
      primaryDisplay
    }).displayId,
    1
  );
});

test("resolveFusionDockBounds preserves the nearest display edge when the saved width changes", () => {
  assert.equal(
    resolveFusionDockBounds({
      defaultHeight: 520,
      defaultWidth: 88,
      displays: [primaryDisplay],
      margin: 20,
      persisted: {
        displayId: 1,
        height: 520,
        width: 124,
        x: 1296,
        y: 214
      },
      primaryDisplay
    }).x,
    1332
  );
  assert.equal(
    resolveFusionDockBounds({
      defaultHeight: 520,
      defaultWidth: 88,
      displays: [primaryDisplay],
      margin: 20,
      persisted: {
        displayId: 1,
        height: 520,
        width: 124,
        x: 20,
        y: 214
      },
      primaryDisplay
    }).x,
    20
  );
});

test("resolveFusionDockWidthTransition expands inward from the nearest display edge", () => {
  assert.deepEqual(
    resolveFusionDockWidthTransition({
      bounds: { height: 520, width: 88, x: 20, y: 214 },
      targetWidth: 420,
      workArea: primaryDisplay.workArea
    }),
    { height: 520, width: 420, x: 20, y: 214 }
  );
  assert.deepEqual(
    resolveFusionDockWidthTransition({
      bounds: { height: 520, width: 88, x: 1332, y: 214 },
      targetWidth: 420,
      workArea: primaryDisplay.workArea
    }),
    { height: 520, width: 420, x: 1000, y: 214 }
  );
});

test("resolveFusionDockWidthTransition clamps a dock after display changes", () => {
  assert.deepEqual(
    resolveFusionDockWidthTransition({
      bounds: { height: 980, width: 420, x: 1200, y: -20 },
      targetWidth: 88,
      workArea: primaryDisplay.workArea
    }),
    { height: 900, width: 88, x: 1352, y: 24 }
  );
});
