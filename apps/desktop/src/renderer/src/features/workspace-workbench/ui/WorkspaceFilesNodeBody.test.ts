import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./WorkspaceFilesNodeBody.tsx", import.meta.url),
  "utf8"
);

test("workspace files node keeps the file preview panel visible", () => {
  assert.match(source, /<WorkspaceFileManagerPane[\s\S]*?showPreviewPanel/);
  assert.doesNotMatch(source, /showPreviewPanel=\{false\}/);
});
