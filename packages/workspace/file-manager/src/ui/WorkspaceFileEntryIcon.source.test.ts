import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./WorkspaceFileEntryIcon.tsx", import.meta.url),
  "utf8"
);
const panelsSource = readFileSync(
  new URL("./WorkspaceFileManagerPanels.tsx", import.meta.url),
  "utf8"
);

test("workspace file entry icons do not render with shadows", () => {
  assert.doesNotMatch(source, /shadow(?:-|\\\[)/);
});

test("workspace folder fallback icon uses the folder asset", () => {
  assert.match(source, /workspace-folder-fallback\.png/);
  assert.doesNotMatch(source, /FolderFilledIcon/);
  assert.match(panelsSource, /WorkspaceFolderFallbackIcon/);
  assert.doesNotMatch(panelsSource, /FolderFilledIcon/);
});

test("workspace image fallback icon uses the image generation asset", () => {
  assert.match(source, /workspace-image-fallback\.png/);
  assert.doesNotMatch(source, /ImageFileIcon/);
  assert.match(panelsSource, /WorkspaceImageFallbackIcon/);
  assert.doesNotMatch(panelsSource, /ImageFileIcon/);
});

test("workspace vector fallback icons stay smaller than image thumbnails", () => {
  assert.match(source, /function vectorFallbackIconClassName/);
  assert.match(source, /size-\[84px\].*size-\[64px\]/s);
});
