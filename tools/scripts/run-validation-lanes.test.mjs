import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatFailureExcerpt,
  formatSlowestLanes,
  runValidationLanes
} from "./run-validation-lanes.mjs";

test("formatSlowestLanes reports the longest lanes first", () => {
  const summary = formatSlowestLanes([
    { durationMs: 1200, label: "medium" },
    { durationMs: 250, label: "fast" },
    { durationMs: 2500, label: "slow" },
    { durationMs: 900, label: "also-fast" }
  ]);

  assert.equal(summary, "slow 2.5s, medium 1.2s, also-fast 0.9s");
});

test("formatSlowestLanes respects an explicit limit", () => {
  assert.equal(
    formatSlowestLanes(
      [
        { durationMs: 3000, label: "one" },
        { durationMs: 2000, label: "two" },
        { durationMs: 1000, label: "three" }
      ],
      2
    ),
    "one 3.0s, two 2.0s"
  );
});

test("formatSlowestLanes ignores missing durations", () => {
  assert.equal(
    formatSlowestLanes([
      { label: "not-started" },
      { durationMs: 500, label: "completed" }
    ]),
    "completed 0.5s"
  );
});

test("formatFailureExcerpt removes runner boilerplate and terminal escapes", () => {
  const excerpt = formatFailureExcerpt(
    [
      "$ pnpm --filter example test",
      "",
      "> example@1.0.0 test /workspace/example",
      "> vitest run",
      "\u001B[31mAssertionError: expected true to be false\u001B[39m",
      "> 12 | expect(value).toBe(false)",
      "at example.test.ts:12:3",
      "at example.test.ts:12:3",
      "ELIFECYCLE Command failed with exit code 1.",
      "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL example test: failed",
      "Exit status 1"
    ].join("\n"),
    80
  );

  assert.deepEqual(excerpt, {
    text: [
      "AssertionError: expected true to be false",
      "> 12 | expect(value).toBe(false)",
      "at example.test.ts:12:3 (repeated 2 times)"
    ].join("\n"),
    truncated: false
  });
});

test("formatFailureExcerpt keeps the most recent high-signal lines", () => {
  const excerpt = formatFailureExcerpt(
    ["setup", "first error", "second error", "final location"].join("\n"),
    2
  );

  assert.deepEqual(excerpt, {
    text: "second error\nfinal location",
    truncated: true
  });
});

test("runValidationLanes prints a filtered failure as soon as its lane ends", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "validation-lanes-"));
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));

  try {
    const result = await runValidationLanes({
      lanes: [
        {
          command: [
            process.execPath,
            "-e",
            [
              'console.error("\\u001b[31mAssertionError: expected true to be false\\u001b[39m")',
              'console.error("at example.test.ts:12:3")',
              'console.error("ELIFECYCLE Command failed with exit code 1.")',
              "process.exit(1)"
            ].join(";")
          ],
          key: "failing-lane",
          label: "failing lane"
        }
      ],
      maxParallel: 1,
      summaryLabel: "fixture tests",
      tailLines: 80,
      tmpDirectoryName: "test-runs/fixture",
      workspaceRoot
    });

    const output = errors.join("\n");
    assert.equal(result.exitCode, 1);
    assert.match(output, /AssertionError: expected true to be false/u);
    assert.match(output, /at example\.test\.ts:12:3/u);
    assert.doesNotMatch(output, /ELIFECYCLE/u);
    assert.match(output, /full logs:/u);
  } finally {
    console.error = originalError;
    rmSync(workspaceRoot, { force: true, recursive: true });
  }
});
