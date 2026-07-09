import assert from "node:assert/strict";
import test from "node:test";
import { windowsCommandLine } from "./run-check-full.mjs";

test("windowsCommandLine quotes cmd arguments for check:full pnpm lanes", () => {
  assert.equal(
    windowsCommandLine([
      "corepack.cmd",
      "pnpm@10.11.0",
      "run",
      "arg with space",
      "a&b"
    ]),
    'corepack.cmd pnpm@10.11.0 run "arg with space" "a&b"'
  );
});
