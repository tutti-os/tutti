import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  printSummary,
  runLanes,
  selectExistingLintFiles
} from "./run-check-changed.mjs";

test("selectExistingLintFiles drops deleted lint targets", () => {
  const changedFiles = [
    "packages/foo/src/live.ts",
    "packages/foo/src/deleted.ts",
    "packages/foo/README.md"
  ];

  const lintFiles = selectExistingLintFiles(
    changedFiles,
    (file) => file !== "packages/foo/src/deleted.ts"
  );

  assert.deepEqual(lintFiles, ["packages/foo/src/live.ts"]);
});

test("selectExistingLintFiles keeps existing lintable paths", () => {
  const changedFiles = [
    "apps/desktop/src/main/index.ts",
    "packages/foo/src/helper.mjs"
  ];

  const lintFiles = selectExistingLintFiles(changedFiles, () => true);

  assert.deepEqual(lintFiles, changedFiles);
});

test("runLanes preserves lane indexes without relying on outer scope", async () => {
  const runDirectory = mkdtempSync(join(tmpdir(), "run-check-changed-"));
  const lanes = [
    {
      key: "lane-b",
      label: "lane-b",
      command: [process.execPath, "-e", "setTimeout(() => {}, 10)"]
    },
    {
      key: "lane-a",
      label: "lane-a",
      command: [process.execPath, "-e", ""]
    }
  ];

  const results = await runLanes(lanes, runDirectory);

  assert.deepEqual(
    results.map((result) => result.index),
    [0, 1]
  );
  assert.deepEqual(
    results.map((result) => result.key),
    ["lane-b", "lane-a"]
  );
});

test("printSummary includes rerun hint for failures", () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args.join(" "));
  };

  try {
    printSummary(
      [
        {
          command: ["pnpm", "lint"],
          durationMs: 10,
          exitCode: 1,
          index: 0,
          key: "lint:changed",
          label: "lint:changed",
          logPath: "/tmp/lint.log",
          logPathRelative: ".tmp/check-runs/example/lint.log"
        }
      ],
      [
        {
          command: ["pnpm", "lint"],
          durationMs: 10,
          exitCode: 1,
          index: 0,
          key: "lint:changed",
          label: "lint:changed",
          logPath: "/tmp/lint.log",
          logPathRelative: ".tmp/check-runs/example/lint.log"
        }
      ],
      10,
      "/tmp/check-runs/example"
    );
  } finally {
    console.error = originalError;
  }

  assert.match(
    errors.at(-1) ?? "",
    /Rerun failed lanes with: pnpm check:changed -- --failed-only/u
  );
});
