import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopCaptureAccelerator,
  resolveCaptureAccelerator
} from "./captureShortcut.ts";

test("capture accelerator follows a valid persisted binding", () => {
  assert.equal(resolveCaptureAccelerator("Meta+Shift+P"), "Meta+Shift+P");
  assert.equal(resolveCaptureAccelerator("Ctrl+Alt+F5"), "Ctrl+Alt+F5");
  assert.equal(resolveCaptureAccelerator("Alt+Space"), "Alt+Space");
  assert.equal(resolveCaptureAccelerator("Meta+ArrowUp"), "Meta+Up");
});

test("capture accelerator falls back to the default for unusable bindings", () => {
  assert.equal(resolveCaptureAccelerator(null), desktopCaptureAccelerator);
  assert.equal(resolveCaptureAccelerator(""), desktopCaptureAccelerator);
  assert.equal(resolveCaptureAccelerator("  "), desktopCaptureAccelerator);
  assert.equal(resolveCaptureAccelerator("S"), desktopCaptureAccelerator);
  // Shift-only bindings would shadow plain typing system-wide.
  assert.equal(resolveCaptureAccelerator("Shift+S"), desktopCaptureAccelerator);
  assert.equal(
    resolveCaptureAccelerator("Meta+Shift"),
    desktopCaptureAccelerator
  );
  assert.equal(resolveCaptureAccelerator("Bogus+S"), desktopCaptureAccelerator);
});
