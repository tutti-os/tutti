import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceTestPlan } from "./run-workspace-tests.mjs";

test("workspace test plan discovers package and tool tests", () => {
  const plan = buildWorkspaceTestPlan({
    packageJsonEntries: [
      {
        path: "packages/example/core/package.json",
        value: { name: "@tutti-os/example", scripts: { test: "node --test" } }
      },
      {
        path: "packages/example/no-tests/package.json",
        value: { name: "@tutti-os/no-tests", scripts: { build: "tsup" } }
      }
    ],
    toolsOnly: false,
    trackedFiles: [
      "packages/example/core/src/index.test.ts",
      "tools/scripts/example.test.mjs"
    ]
  });

  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.packages, [
    {
      name: "@tutti-os/example",
      root: "packages/example/core",
      testFileCount: 1
    }
  ]);
  assert.deepEqual(plan.toolTests, ["tools/scripts/example.test.mjs"]);
});

test("workspace test plan rejects stale zero-test scripts", () => {
  const plan = buildWorkspaceTestPlan({
    packageJsonEntries: [
      {
        path: "packages/example/core/package.json",
        value: { name: "@tutti-os/example", scripts: { test: "node --test" } }
      }
    ],
    toolsOnly: false,
    trackedFiles: [
      "packages/example/core/src/index.ts",
      "tools/scripts/example.test.mjs"
    ]
  });

  assert.equal(plan.packages.length, 0);
  assert.match(plan.errors[0], /declares a test script/u);
});

test("tools-only plans skip package completeness checks", () => {
  const plan = buildWorkspaceTestPlan({
    packageJsonEntries: [
      {
        path: "packages/example/core/package.json",
        value: { name: "@tutti-os/example", scripts: { test: "node --test" } }
      }
    ],
    toolsOnly: true,
    trackedFiles: ["tools/scripts/example.test.mjs"]
  });

  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.packages, []);
});
