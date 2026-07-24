import assert from "node:assert/strict";
import test from "node:test";
import { restoreWorkbenchFrameToLayout } from "./snapshotLayout.ts";
import type { WorkbenchLayoutConstraints } from "./types.ts";

const layoutConstraints: WorkbenchLayoutConstraints = {
  minWidth: 280,
  minHeight: 160,
  surfacePadding: 0,
  safeArea: { top: 52, right: 0, bottom: 88, left: 0 }
};

test("restores a frame proportionally between persisted layout bases", () => {
  const restored = restoreWorkbenchFrameToLayout({
    frame: { x: 151.2, y: 127.7, width: 907.2, height: 454.2 },
    sourceLayoutBasis: {
      surfaceSize: { width: 1512, height: 897 },
      layoutConstraints
    },
    targetSurfaceSize: { width: 1210, height: 759 },
    targetLayoutConstraints: layoutConstraints
  });

  assert.deepEqual(restored, {
    x: 121,
    y: 113.9,
    width: 726,
    height: 371.4
  });
});

test("clamps legacy frames without a layout basis into the current layout", () => {
  const restored = restoreWorkbenchFrameToLayout({
    frame: { x: 221, y: 83, width: 1480, height: 792 },
    targetSurfaceSize: { width: 1210, height: 759 },
    targetLayoutConstraints: layoutConstraints
  });

  assert.deepEqual(restored, {
    x: 0,
    y: 52,
    width: 1210,
    height: 619
  });
});
