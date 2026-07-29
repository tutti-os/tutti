import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspaceTestPlan,
  parseWorkspaceTestPackageFilters,
  parseWorkspaceTestShard,
  selectWorkspaceTestPackages,
  shardWorkspaceTestPackages
} from "./run-workspace-tests.mjs";

test("workspace test plan discovers package tests without repository tools", () => {
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
  assert.deepEqual(plan.toolTests, []);
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
  assert.deepEqual(plan.toolTests, ["tools/scripts/example.test.mjs"]);
});

test("parses a workspace test package subset with runner options", () => {
  assert.deepEqual(
    parseWorkspaceTestPackageFilters([
      "--",
      "--max-parallel",
      "1",
      "--shard",
      "1/3",
      "--packages-json",
      '["@tutti-os/agent-gui"]'
    ]),
    ["@tutti-os/agent-gui"]
  );
  assert.equal(parseWorkspaceTestPackageFilters([]), null);
  assert.throws(
    () => parseWorkspaceTestPackageFilters(["--packages-json", "not-json"]),
    /valid JSON/u
  );
  assert.throws(
    () => parseWorkspaceTestPackageFilters(["--packages", "agent-gui"]),
    /unknown workspace test option/u
  );
});

test("parses and validates a workspace test shard", () => {
  assert.deepEqual(parseWorkspaceTestShard(["--shard", "2/3"]), {
    index: 2,
    total: 3
  });
  assert.equal(parseWorkspaceTestShard([]), null);
  assert.throws(
    () => parseWorkspaceTestShard(["--shard", "0/3"]),
    /between 1/u
  );
  assert.throws(
    () => parseWorkspaceTestShard(["--shard", "4/3"]),
    /between 1/u
  );
  assert.throws(
    () => parseWorkspaceTestShard(["--shard", "one"]),
    /index\/total/u
  );
});

test("selects only requested workspace test packages", () => {
  const packages = [
    { name: "@tutti-os/agent-gui", root: "packages/agent/gui" },
    { name: "@tutti-os/ui-system", root: "packages/ui/system" }
  ];

  assert.deepEqual(
    selectWorkspaceTestPackages(packages, ["@tutti-os/agent-gui"]),
    {
      errors: [],
      packages: [packages[0]]
    }
  );
  assert.deepEqual(
    selectWorkspaceTestPackages(packages, ["@tutti-os/missing"]),
    {
      errors: ["Unknown workspace test package filter(s): @tutti-os/missing"],
      packages: []
    }
  );
});

test("partitions workspace tests deterministically by plan order", () => {
  const packages = [
    { name: "one", root: "apps/one" },
    { name: "two", root: "apps/two" },
    { name: "three", root: "packages/three" },
    { name: "four", root: "packages/four" }
  ];

  assert.deepEqual(
    shardWorkspaceTestPackages(packages, { index: 1, total: 3 }),
    [packages[0], packages[3]]
  );
  assert.deepEqual(
    shardWorkspaceTestPackages(packages, { index: 2, total: 3 }),
    [packages[1]]
  );
  assert.deepEqual(shardWorkspaceTestPackages(packages, null), packages);
});

test("balances workspace test shards by package test file count", () => {
  const packages = [
    { name: "heavy", root: "apps/heavy", testFileCount: 100 },
    { name: "medium", root: "apps/medium", testFileCount: 90 },
    { name: "small-one", root: "packages/small-one", testFileCount: 30 },
    { name: "small-two", root: "packages/small-two", testFileCount: 30 },
    { name: "small-three", root: "packages/small-three", testFileCount: 30 }
  ];

  assert.deepEqual(
    shardWorkspaceTestPackages(packages, { index: 1, total: 3 }),
    [packages[0]]
  );
  assert.deepEqual(
    shardWorkspaceTestPackages(packages, { index: 2, total: 3 }),
    [packages[1]]
  );
  assert.deepEqual(
    shardWorkspaceTestPackages(packages, { index: 3, total: 3 }),
    packages.slice(2)
  );
});
