import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCaptureSelection,
  resolveCaptureComposerBounds,
  resolveCaptureTitle
} from "./captureGeometry.ts";

test("normalizeCaptureSelection clamps a drag to the display", () => {
  assert.deepEqual(
    normalizeCaptureSelection(
      { x: 90, y: 70, width: 40, height: 50 },
      { width: 100, height: 80 }
    ),
    { x: 90, y: 70, width: 10, height: 10 }
  );
});

test("normalizeCaptureSelection rejects non-finite coordinates", () => {
  assert.throws(
    () =>
      normalizeCaptureSelection(
        { x: Number.NaN, y: 0, width: 40, height: 50 },
        { width: 100, height: 80 }
      ),
    /invalid/u
  );
});

test("resolveCaptureComposerBounds flips above a bottom-edge selection", () => {
  assert.deepEqual(
    resolveCaptureComposerBounds({
      composerHeight: 500,
      composerWidth: 480,
      displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
      selection: { x: 900, y: 700, width: 300, height: 180 },
      workArea: { x: 0, y: 24, width: 1440, height: 876 }
    }),
    { x: 720, y: 188, width: 480, height: 500 }
  );
});

test("resolveCaptureComposerBounds restores and clamps the remembered position", () => {
  assert.deepEqual(
    resolveCaptureComposerBounds({
      composerHeight: 500,
      composerWidth: 760,
      displayBounds: { x: 1440, y: 0, width: 1920, height: 1080 },
      rememberedPosition: { x: -500, y: 900 },
      selection: { x: 20, y: 20, width: 100, height: 100 },
      workArea: { x: 1440, y: 24, width: 1920, height: 1016 }
    }),
    { x: 1440, y: 540, width: 760, height: 500 }
  );
});

test("resolveCaptureTitle uses the note first line and screenshot fallback", () => {
  assert.equal(
    resolveCaptureTitle("  Fix this layout\nMore details", "shot.png"),
    "Fix this layout"
  );
  assert.equal(
    resolveCaptureTitle("", "Screenshot-2026.png"),
    "Screenshot-2026"
  );
});
