import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "desktopAgentGUIWorkbenchModel.ts"
  ),
  "utf8"
);

test("Agent GUI context equality observes presentation and minimized state", () => {
  assert.match(source, /previous\.presentationMode === next\.presentationMode/);
  assert.match(
    source,
    /previous\.node\.isMinimized === next\.node\.isMinimized/
  );
});

test("Agent GUI context equality suppresses frame ticks during direct manipulation", () => {
  assert.match(source, /previous\.isDragging === next\.isDragging/);
  assert.match(source, /previous\.isResizing === next\.isResizing/);
  assert.match(
    source,
    /if \(next\.isDragging \|\| next\.isResizing\) \{\s*return true;/
  );
  assert.match(
    source,
    /previous\.node\.frame\.width === next\.node\.frame\.width/
  );
});
