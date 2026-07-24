import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveStandaloneAgentWindowBounds,
  resolveStandaloneAgentWindowContentWidth,
  resolveStandaloneAgentWindowOffsetBounds,
  resolveStandaloneAgentWindowWorkArea,
  shouldAnimateStandaloneAgentWindowResize
} from "./standaloneAgentWindowBounds.ts";

test("standalone agent window animates requested content resizes only on macOS", () => {
  assert.equal(shouldAnimateStandaloneAgentWindowResize("darwin"), false);
  assert.equal(shouldAnimateStandaloneAgentWindowResize("darwin", true), true);
  assert.equal(shouldAnimateStandaloneAgentWindowResize("win32"), false);
  assert.equal(shouldAnimateStandaloneAgentWindowResize("win32", true), false);
  assert.equal(shouldAnimateStandaloneAgentWindowResize("linux"), false);
  assert.equal(shouldAnimateStandaloneAgentWindowResize("linux", true), false);
});

test("standalone agent window derives its work area from a workspace opener", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowWorkArea({
      bottomInset: 64,
      fallbackWorkArea: { height: 1000, width: 1600, x: 0, y: 24 },
      openerBounds: { height: 900, width: 1440, x: 100, y: 50 },
      topInset: 52
    }),
    { height: 784, width: 1440, x: 100, y: 102 }
  );
});

test("standalone agent window opens at 90 percent of the active work area", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowBounds({
      minHeight: 520,
      minWidth: 420,
      scale: 0.9,
      workArea: { height: 1000, width: 1600, x: 0, y: 24 }
    }),
    { height: 900, width: 1440, x: 80, y: 74 }
  );
});

test("standalone agent window centers within a non-primary work area", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowBounds({
      minHeight: 520,
      minWidth: 420,
      scale: 0.9,
      workArea: { height: 1080, width: 1600, x: 1440, y: 0 }
    }),
    { height: 972, width: 1440, x: 1520, y: 54 }
  );
});

test("standalone agent window keeps minimums when 90 percent is too small", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowBounds({
      minHeight: 520,
      minWidth: 420,
      scale: 0.9,
      workArea: { height: 480, width: 460, x: 10, y: 30 }
    }),
    { height: 520, width: 420, x: 30, y: 30 }
  );
});

test("standalone agent window offsets a duplicate right and down", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowOffsetBounds({
      offset: 25,
      sourceBounds: { height: 800, width: 1200, x: 100, y: 80 },
      targetBounds: { height: 900, width: 1440, x: 80, y: 74 },
      workArea: { height: 1080, width: 1920, x: 0, y: 24 }
    }),
    { height: 900, width: 1440, x: 125, y: 105 }
  );
});

test("standalone agent window keeps an offset duplicate inside the display", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowOffsetBounds({
      offset: 25,
      sourceBounds: { height: 900, width: 1440, x: 500, y: 180 },
      targetBounds: { height: 900, width: 1440, x: 80, y: 74 },
      workArea: { height: 1080, width: 1920, x: 0, y: 24 }
    }),
    { height: 900, width: 1440, x: 480, y: 204 }
  );
});

test("standalone agent window grows to the right when the display has room", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowContentWidth({
      currentBounds: { height: 830, width: 1000, x: 100, y: 80 },
      minWidth: 460,
      requestedWidth: 1480,
      workArea: { height: 1000, width: 1920, x: 0, y: 24 }
    }),
    { height: 830, width: 1480, x: 100, y: 80 }
  );
});

test("standalone agent window shifts left only when right-side room runs out", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowContentWidth({
      currentBounds: { height: 830, width: 1000, x: 700, y: 80 },
      minWidth: 460,
      requestedWidth: 1480,
      workArea: { height: 1000, width: 1920, x: 0, y: 24 }
    }),
    { height: 830, width: 1480, x: 440, y: 80 }
  );
});

test("standalone agent window width stays inside the active display", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowContentWidth({
      currentBounds: { height: 760, width: 900, x: 1530, y: 30 },
      minWidth: 460,
      requestedWidth: 2200,
      workArea: { height: 1080, width: 1600, x: 1440, y: 0 }
    }),
    { height: 760, width: 1600, x: 1440, y: 30 }
  );
});

test("standalone agent window refuses content widths below its collapsed minimum", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowContentWidth({
      currentBounds: { height: 760, width: 900, x: 100, y: 30 },
      minWidth: 460,
      requestedWidth: 320,
      workArea: { height: 1080, width: 1600, x: 0, y: 0 }
    }),
    { height: 760, width: 460, x: 100, y: 30 }
  );
});
