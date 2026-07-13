import assert from "node:assert/strict";
import test from "node:test";
import { createFusionDockWindowOptions } from "./fusionDockWindowOptions.ts";

test("Fusion Dock uses a focusable native window without the invalid macOS panel mask", () => {
  const options = createFusionDockWindowOptions({
    bounds: { height: 520, width: 380, x: 20, y: 221 },
    preloadPath: "/app/preload.cjs"
  });

  assert.equal("type" in options, false);
  assert.deepEqual(
    {
      alwaysOnTop: options.alwaysOnTop,
      frame: options.frame,
      hasShadow: options.hasShadow,
      height: options.height,
      show: options.show,
      skipTaskbar: options.skipTaskbar,
      transparent: options.transparent,
      width: options.width,
      x: options.x,
      y: options.y
    },
    {
      alwaysOnTop: true,
      frame: false,
      hasShadow: false,
      height: 520,
      show: false,
      skipTaskbar: true,
      transparent: true,
      width: 380,
      x: 20,
      y: 221
    }
  );
});
