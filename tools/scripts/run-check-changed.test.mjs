import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildLaneInputFingerprint,
  mergeLaneResults,
  resolveRetryPushReady,
  selectFailedOnlyLanes
} from "./run-check-changed-cache.mjs";
import {
  parseCliArgs,
  printSummary,
  runLanes,
  selectExistingLintFiles
} from "./run-check-changed.mjs";
import {
  isAgentActivityRuntimeBoundaryRelevant,
  isRendererBoundaryRelevant
} from "./repository-checks.mjs";
import { createIsolatedGitEnvironment } from "./git-environment.mjs";

isolateProcessGitEnvironment(createIsolatedGitEnvironment(tmpdir()));

test("parseCliArgs rejects unknown and invalid options", () => {
  assert.throws(() => parseCliArgs(["--push-reddy"]), /unknown option/u);
  assert.throws(
    () => parseCliArgs(["--max-parallel", "nope"]),
    /positive integer/u
  );
  assert.throws(() => parseCliArgs(["--base"]), /requires a value/u);
});

test("parseCliArgs accepts pnpm separators and explicit values", () => {
  assert.deepEqual(
    parseCliArgs([
      "--",
      "--dry-run",
      "--push-ready",
      "--base",
      "origin/trunk",
      "--max-parallel",
      "2",
      "--tail-lines",
      "40"
    ]),
    {
      baseRef: "origin/trunk",
      dryRun: true,
      failedOnly: false,
      maxParallel: 2,
      pushReady: true,
      tailLines: 40,
      verbose: false
    }
  );
});

test("lane input fingerprints change only with their own inputs", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "check-fingerprint-"));
  runFixtureGit(workspaceRoot, ["init", "--quiet"]);
  const sourcePath = join(workspaceRoot, "source.ts");
  const helperPath = join(workspaceRoot, "helper.ts");
  writeFileSync(sourcePath, "export const value = 1;\n");
  writeFileSync(helperPath, "export const helper = 1;\n");
  runFixtureGit(workspaceRoot, ["add", "source.ts", "helper.ts"]);
  runFixtureGit(workspaceRoot, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--quiet",
    "-m",
    "init"
  ]);
  const sourceLane = {
    key: "source",
    label: "source",
    command: ["check", "source.ts"],
    inputFiles: ["source.ts"]
  };
  const helperLane = {
    key: "helper",
    label: "helper",
    command: ["check", "helper.ts"],
    inputFiles: ["helper.ts"]
  };
  const initialSource = buildLaneInputFingerprint({
    baseRef: "HEAD",
    lane: sourceLane,
    workspaceRoot
  });
  const initialHelper = buildLaneInputFingerprint({
    baseRef: "HEAD",
    lane: helperLane,
    workspaceRoot
  });

  writeFileSync(sourcePath, "export const value = 2;\n");
  const workingSource = buildLaneInputFingerprint({
    baseRef: "HEAD",
    lane: sourceLane,
    workspaceRoot
  });
  const workingHelper = buildLaneInputFingerprint({
    baseRef: "HEAD",
    lane: helperLane,
    workspaceRoot
  });
  assert.notEqual(workingSource, initialSource);
  assert.equal(workingHelper, initialHelper);

  runFixtureGit(workspaceRoot, ["add", "source.ts"]);
  writeFileSync(sourcePath, "export const value = 3;\n");
  const staged = buildLaneInputFingerprint({
    baseRef: "HEAD",
    lane: sourceLane,
    workspaceRoot
  });
  runFixtureGit(workspaceRoot, ["reset", "--quiet"]);
  const unstaged = buildLaneInputFingerprint({
    baseRef: "HEAD",
    lane: sourceLane,
    workspaceRoot
  });
  assert.notEqual(staged, unstaged);
});

test("lane input fingerprints support diffs larger than the spawnSync default buffer", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "check-large-fingerprint-"));
  runFixtureGit(workspaceRoot, ["init", "--quiet"]);
  const sourcePath = join(workspaceRoot, "source.txt");
  writeFileSync(sourcePath, "initial\n");
  runFixtureGit(workspaceRoot, ["add", "source.txt"]);
  runFixtureGit(workspaceRoot, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--quiet",
    "-m",
    "init"
  ]);
  writeFileSync(sourcePath, `${"x".repeat(2 * 1024 * 1024)}\n`);

  const fingerprint = buildLaneInputFingerprint({
    baseRef: "HEAD",
    lane: {
      key: "large-source",
      label: "large-source",
      command: ["check", "source.txt"],
      inputFiles: ["source.txt"]
    },
    workspaceRoot
  });

  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
});

test("failed-only reuses only passed lanes with unchanged inputs", () => {
  const currentLanes = [
    laneFixture("passed-unchanged", "same"),
    laneFixture("failed-unchanged", "same"),
    laneFixture("passed-changed", "after"),
    laneFixture("new-lane", "new")
  ];
  const summary = {
    laneFingerprintVersion: 1,
    results: [
      resultFixture("passed-unchanged", "same", 0),
      resultFixture("failed-unchanged", "same", 1),
      resultFixture("passed-changed", "before", 0),
      resultFixture("removed-lane", "same", 0)
    ]
  };

  const selection = selectFailedOnlyLanes(currentLanes, summary);

  assert.deepEqual(
    selection.lanesToRun.map((lane) => lane.key),
    ["failed-unchanged", "passed-changed", "new-lane"]
  );
  assert.deepEqual(
    selection.reusedResults.map((result) => result.key),
    ["passed-unchanged"]
  );
});

test("failed-only rejects summaries without lane fingerprints", () => {
  assert.throws(
    () => selectFailedOnlyLanes([], { results: [] }),
    /legacy failed-lane state/u
  );
});

test("failed-only inherits push-ready lanes from the previous run", () => {
  assert.equal(resolveRetryPushReady(false, { pushReady: true }), true);
  assert.equal(resolveRetryPushReady(false, { pushReady: false }), false);
  assert.equal(resolveRetryPushReady(true, { pushReady: false }), true);
});

test("failed-only keeps reused results available for the next retry", () => {
  const currentLanes = [
    laneFixture("passed", "same"),
    laneFixture("retried", "fixed")
  ];
  const firstSelection = selectFailedOnlyLanes(currentLanes, {
    laneFingerprintVersion: 1,
    results: [
      resultFixture("passed", "same", 0),
      resultFixture("retried", "broken", 1)
    ]
  });
  const mergedResults = mergeLaneResults(
    currentLanes,
    [resultFixture("retried", "fixed", 0)],
    firstSelection.reusedResults
  );

  const nextSelection = selectFailedOnlyLanes(currentLanes, {
    laneFingerprintVersion: 1,
    results: mergedResults
  });

  assert.deepEqual(nextSelection.lanesToRun, []);
  assert.deepEqual(
    nextSelection.reusedResults.map((result) => result.key),
    ["passed", "retried"]
  );
});

test("renderer boundary lane covers renderer and checker changes", () => {
  for (const file of [
    "apps/desktop/src/renderer/src/features/workspace-workbench/services/coordinator.ts",
    "tools/scripts/check-renderer-feature-boundaries.mjs",
    "tools/scripts/check-renderer-feature-boundaries.test.mjs"
  ]) {
    assert.equal(isRendererBoundaryRelevant(file), true, file);
  }
  assert.equal(
    isRendererBoundaryRelevant("apps/desktop/src/main/index.ts"),
    false
  );
});

test("activity runtime boundary lane covers package, desktop adapter, and checker changes", () => {
  for (const file of [
    "packages/agent/gui/AgentGUI.tsx",
    "packages/agent/activity-core/src/engine/engine.ts",
    "apps/desktop/src/renderer/src/features/workspace-agent/services/runtime.ts",
    "apps/desktop/src/renderer/src/features/workspace-workbench/ui/Agent.tsx",
    "tools/scripts/check-agent-activity-runtime-boundaries.mjs",
    "tools/scripts/check-agent-activity-runtime-boundaries.test.mjs"
  ]) {
    assert.equal(isAgentActivityRuntimeBoundaryRelevant(file), true, file);
  }
  assert.equal(
    isAgentActivityRuntimeBoundaryRelevant(
      "apps/desktop/src/renderer/src/features/workspace-file-manager/file.ts"
    ),
    false
  );
});

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

function runFixtureGit(workspaceRoot, args) {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: createIsolatedGitEnvironment(workspaceRoot)
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function laneFixture(key, inputFingerprint) {
  return {
    command: ["check", key],
    inputFiles: [`${key}.ts`],
    inputFingerprint,
    key,
    label: key
  };
}

function resultFixture(key, inputFingerprint, exitCode) {
  return {
    ...laneFixture(key, inputFingerprint),
    durationMs: 10,
    exitCode,
    index: 0,
    logPath: `/tmp/${key}.log`,
    logPathRelative: `.tmp/${key}.log`
  };
}

function isolateProcessGitEnvironment(nextEnvironment) {
  for (const name of Object.keys(process.env)) {
    if (!Object.hasOwn(nextEnvironment, name)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, nextEnvironment);
}
