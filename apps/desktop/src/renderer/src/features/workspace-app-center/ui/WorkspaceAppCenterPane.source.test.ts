import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./WorkspaceAppCenterPane.tsx", import.meta.url),
  "utf8"
);

test("App Center passes the Tutti package icon for official developer sources", () => {
  assert.match(source, /dock\/default\/tutti\.png/);
  assert.match(source, /officialDeveloperIconUrl=\{tuttiDeveloperIconUrl\}/);
});
