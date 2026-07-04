import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./WorkspaceWorkbenchTrafficLights.ts", import.meta.url),
  "utf8"
);

test("workspace traffic light controls keep accessible labels without hover tooltips", () => {
  assert.match(source, /"aria-label": label/);
  assert.doesNotMatch(source, /TooltipContent/);
  assert.doesNotMatch(source, /TooltipTrigger/);
});
