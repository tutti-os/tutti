import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeRuntimeImage,
  isRuntimeImageBudgetPath,
  readPngDimensions,
  runtimeImageBudgetForPath
} from "./check-runtime-image-budgets.mjs";

function pngHeader(width, height, byteLength = 24) {
  const content = Buffer.alloc(byteLength);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(content);
  content.write("IHDR", 12, "ascii");
  content.writeUInt32BE(width, 16);
  content.writeUInt32BE(height, 20);
  return content;
}

test("reads PNG dimensions from IHDR", () => {
  assert.deepEqual(readPngDimensions(pngHeader(192, 128)), {
    width: 192,
    height: 128
  });
});

test("directory budgets cover new Dock assets", () => {
  const path =
    "apps/desktop/src/renderer/src/assets/workspace-canvas/dock/default/new-app.png";

  assert.equal(isRuntimeImageBudgetPath(path), true);
  assert.deepEqual(runtimeImageBudgetForPath(path), {
    prefix: "apps/desktop/src/renderer/src/assets/workspace-canvas/dock/",
    maxLongEdge: 192,
    maxBytes: 96 * 1024
  });
});

test("design masters and unbounded screenshots are excluded", () => {
  assert.equal(
    isRuntimeImageBudgetPath(
      "design-assets/runtime-images/originals/apps/desktop/src/renderer/src/assets/workspace-canvas/dock/default/codex.png"
    ),
    false
  );
  assert.equal(
    isRuntimeImageBudgetPath(
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/tutti-workspace.png"
    ),
    false
  );
});

test("reports dimension and byte regressions", () => {
  const path =
    "packages/agent/gui/app/renderer/assets/icons/agent-vinyls/new.png";
  const diagnostics = analyzeRuntimeImage({
    path,
    content: pngHeader(256, 256, 100 * 1024)
  });

  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0], /256×256 exceeds 128px/u);
  assert.match(diagnostics[1], /100 KiB exceeds 96 KiB/u);
});

test("accepts an image inside both budgets", () => {
  const diagnostics = analyzeRuntimeImage({
    path: "packages/commerce/web/src/assets/star-pro.png",
    content: pngHeader(64, 64, 8 * 1024)
  });

  assert.deepEqual(diagnostics, []);
});

test("rejects invalid PNG content", () => {
  const diagnostics = analyzeRuntimeImage({
    path: "packages/commerce/web/src/assets/star-pro.png",
    content: Buffer.from("not a png")
  });

  assert.deepEqual(diagnostics, [
    "packages/commerce/web/src/assets/star-pro.png: not a valid PNG header"
  ]);
});
