import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./workspaceFilePreviewNodeController.ts", import.meta.url),
  "utf8"
);

test("workspace file preview controller saves every text file through tuttid", () => {
  assert.match(source, /await saveWorkspaceFilePreviewText\(\{/);
  assert.doesNotMatch(
    source,
    /if \(isAbsoluteFilesystemPath\(target\.path\)\) \{\s*return;\s*\}/
  );
  assert.doesNotMatch(source, /writeLocalFileText/);
});
