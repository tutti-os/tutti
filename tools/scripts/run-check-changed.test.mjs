import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildValidationFingerprint,
  parseCliArgs,
  printSummary,
  runLanes,
  selectExistingLintFiles,
  validateFailedRunSummary
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

test("validation fingerprint changes with working and staged state", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "check-fingerprint-"));
  runFixtureGit(workspaceRoot, ["init", "--quiet"]);
  const sourcePath = join(workspaceRoot, "source.ts");
  writeFileSync(sourcePath, "export const value = 1;\n");
  runFixtureGit(workspaceRoot, ["add", "source.ts"]);
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
  const initial = buildValidationFingerprint({
    baseRef: "HEAD",
    workspaceRoot
  });
  const differentBase = buildValidationFingerprint({
    baseRef: "HEAD^{commit}",
    workspaceRoot
  });
  assert.notEqual(differentBase, initial);

  writeFileSync(sourcePath, "export const value = 2;\n");
  const working = buildValidationFingerprint({
    baseRef: "HEAD",
    workspaceRoot
  });
  assert.notEqual(working, initial);

  runFixtureGit(workspaceRoot, ["add", "source.ts"]);
  writeFileSync(sourcePath, "export const value = 3;\n");
  const staged = buildValidationFingerprint({ baseRef: "HEAD", workspaceRoot });
  runFixtureGit(workspaceRoot, ["reset", "--quiet"]);
  const unstaged = buildValidationFingerprint({
    baseRef: "HEAD",
    workspaceRoot
  });
  assert.notEqual(staged, unstaged);
});

test("failed-only state must match the validated workspace", () => {
  assert.throws(
    () => validateFailedRunSummary({ baseRef: "HEAD" }, null),
    /legacy failed-lane state/u
  );
  assert.throws(
    () =>
      validateFailedRunSummary(
        { baseRef: "HEAD", validationFingerprint: "before" },
        "after"
      ),
    /workspace or base changed/u
  );
  assert.doesNotThrow(() =>
    validateFailedRunSummary(
      { baseRef: "HEAD", validationFingerprint: "same" },
      "same"
    )
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

function isolateProcessGitEnvironment(nextEnvironment) {
  for (const name of Object.keys(process.env)) {
    if (!Object.hasOwn(nextEnvironment, name)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, nextEnvironment);
}
