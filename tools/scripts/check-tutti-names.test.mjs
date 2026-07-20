import assert from "node:assert/strict";
import test from "node:test";

import { findLegacyNameViolations } from "./check-tutti-names.mjs";

test("allows only declared legacy compatibility contracts", () => {
  const legacyUpperName = ["N", "E", "X", "T", "O", "P"].join("");
  const files = new Map([
    [
      "packages/auth/bridge/src/shared.ts",
      `export const id = '${legacyUpperName}_APP_ID'`
    ],
    [
      "services/tuttid/service/workspace/app_runtime_env.go",
      `const removedRoot = "${legacyUpperName}_WORKSPACE_ROOT"`
    ],
    ["packages/example/src/index.ts", "export const product = 'Tutti'"]
  ]);

  assert.deepEqual(
    findLegacyNameViolations([...files.keys()], (file) => files.get(file)),
    []
  );
});

test("rejects legacy product tokens in paths and undeclared content", () => {
  const legacyName = ["n", "e", "x", "t", "o", "p"].join("");
  const files = new Map([
    [`packages/${legacyName}/clean.txt`, "clean"],
    ["packages/example/src/index.ts", `export const product = '${legacyName}'`]
  ]);

  assert.deepEqual(
    findLegacyNameViolations([...files.keys()], (file) => files.get(file)),
    [...files.keys()]
  );
});
