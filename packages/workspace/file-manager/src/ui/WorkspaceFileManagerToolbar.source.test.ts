import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./WorkspaceFileManagerToolbar.tsx", import.meta.url),
  "utf8"
);

test("workspace file manager search input uses transparent block chrome", () => {
  assert.match(
    source,
    /relative h-7 w-\[min\(220px,34vw\)\][^"]*bg-\[var\(--transparency-block\)\][^"]*transition-\[width,opacity,background-color\]/
  );
  assert.doesNotMatch(source, /bg-\[var\(--background-fronted\)\] shadow-sm/);
  assert.doesNotMatch(
    source,
    /relative h-7 w-\[min\(220px,34vw\)\][^"]*border border-\[var\(--border-1\)\]/
  );
});
