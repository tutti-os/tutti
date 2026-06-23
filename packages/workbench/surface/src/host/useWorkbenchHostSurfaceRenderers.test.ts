import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve("src/host/useWorkbenchHostSurfaceRenderers.tsx"),
  "utf8"
);

test("minimized dock anchor resolution includes pending minimized nodes", () => {
  assert.match(
    source,
    /const snapshotNodes = input\.hostSession\.getSnapshot\(\)\.nodes/
  );
  assert.match(source, /const slotNodes = snapshotNodes\.some/);
  assert.match(source, /snapshotNode\.id === node\.id \? node : snapshotNode/);
  assert.match(source, /\[\.{3}snapshotNodes, node\]/);
  assert.match(
    source,
    /resolveWorkbenchMinimizedDockSlots\(\{[\s\S]*nodes: slotNodes/
  );
});

test("component minimized previews do not request snapshot preview capture", () => {
  assert.match(source, /const shouldCaptureNodePreviewImage = useCallback/);
  assert.match(source, /return minimizedDock\?\.kind !== "component";/);
  assert.match(source, /const renderNodeGeniePreview = useCallback/);
  assert.match(source, /if \(minimizedDock\?\.kind !== "component"\)/);
  assert.match(source, /minimizedDock\.providePreview/);
  assert.match(source, /workbench-genie-preview-capture__preview/);
  assert.match(source, /shouldCaptureNodePreviewImage,/);
  assert.match(source, /renderNodeGeniePreview,/);
});
