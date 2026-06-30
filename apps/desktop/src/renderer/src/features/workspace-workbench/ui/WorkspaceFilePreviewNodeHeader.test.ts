import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./WorkspaceFilePreviewNodeHeader.tsx", import.meta.url),
  "utf8"
);

test("workspace file preview header keeps traffic lights on the left", () => {
  assert.match(
    source,
    /\{context\.defaultActions\}[\s\S]*\{\.\.\.context\.dragHandleProps\}/
  );
});
