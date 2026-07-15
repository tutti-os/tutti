import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createIsolatedGitEnvironment } from "../../../../tools/scripts/git-environment.mjs";

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "plan-review.mjs"
);

test("plans tasks, risk, and preflight signals from a real git diff", async () => {
  const workspaceRoot = await createFixtureRepo();

  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/renderer/src/App.tsx",
    'import { app } from "electron";\nconsole.log(app);\n'
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "services/tuttid/api/generated/types.gen.go",
    "package generated\n\ntype WorkbenchSnapshot struct{}\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "packages/workbench/surface/package.json",
    '{ "name": "@tutti/workbench-surface", "version": "0.0.1" }\n'
  );

  const result = runPlanner(workspaceRoot, [
    "--format",
    "json",
    "--no-untracked"
  ]);

  assert.equal(result.status, 0, result.stderr);

  const taskPackage = JSON.parse(result.stdout);
  const taskIds = taskPackage.tasks.map((task) => task.id);

  assert.ok(taskIds.includes("desktop-layering"));
  assert.ok(taskIds.includes("contracts-and-generated-sources"));
  assert.ok(taskIds.includes("cross-cutting-architecture"));
  assert.ok(
    taskPackage.preflightSignals.some(
      (signal) => signal.id === "renderer-direct-platform-import"
    )
  );
  assert.ok(
    taskPackage.preflightSignals.some(
      (signal) => signal.id === "generated-without-source"
    )
  );

  const desktopTask = taskPackage.tasks.find(
    (task) => task.id === "desktop-layering"
  );
  assert.equal(desktopTask.riskLevel, "high");
  assert.equal(desktopTask.spawnRecommendation, "required");
});

test("flags possible duplicate event infrastructure in owning reviewers", async () => {
  const workspaceRoot = await createFixtureRepo();

  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/renderer/src/App.tsx",
    "export class EventBus {}\n"
  );

  const result = runPlanner(workspaceRoot, [
    "--format",
    "json",
    "--no-untracked"
  ]);

  assert.equal(result.status, 0, result.stderr);

  const taskPackage = JSON.parse(result.stdout);
  const desktopTask = taskPackage.tasks.find(
    (task) => task.id === "desktop-layering"
  );

  assert.ok(
    taskPackage.preflightSignals.some(
      (signal) => signal.id === "possible-duplicate-event-infra"
    )
  );
  assert.ok(
    desktopTask.preflightSignals.some(
      (signal) => signal.id === "possible-duplicate-event-infra"
    )
  );
});

test("--task filters generated packages to one reviewer", async () => {
  const workspaceRoot = await createFixtureRepo();

  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/main/ipc/workspace.ts",
    "export const workspaceIpc = true;\n"
  );

  const result = runPlanner(workspaceRoot, [
    "--format",
    "json",
    "--no-untracked",
    "--task",
    "desktop-layering"
  ]);

  assert.equal(result.status, 0, result.stderr);

  const taskPackage = JSON.parse(result.stdout);
  assert.equal(taskPackage.tasks.length, 1);
  assert.equal(taskPackage.tasks[0].id, "desktop-layering");
  assert.equal(taskPackage.workflowEntry.taskFilter, "desktop-layering");
});

test("--from-package with --format summary does not require a git repository", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tutti-review-package-"));
  const packagePath = join(workspaceRoot, "task-package.json");

  await writeFile(
    packagePath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: "2026-05-21T00:00:00.000Z",
        repoRoot: "/example/tutti",
        mode: "worktree",
        changedFiles: [],
        preflightSignals: [],
        crossCuttingReasons: [],
        workflowEntry: {
          packagePath
        },
        tasks: [sampleTask("desktop-layering"), sampleTask("tuttid-layering")],
        empty: false
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runPlanner(workspaceRoot, [
    "--from-package",
    packagePath,
    "--task",
    "desktop-layering",
    "--format",
    "summary"
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Tutti Architecture Review Summary/);
  assert.match(result.stdout, /\| desktop-layering \|/);
  assert.doesNotMatch(result.stdout, /\| tuttid-layering \|/);
  assert.match(result.stdout, /Task filter: desktop-layering/);
});

test("--scope-file narrows diff review to matching scoped paths", async () => {
  const workspaceRoot = await createFixtureRepo();
  const scopePath = join(workspaceRoot, "review-scope.json");

  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/main/ipc/workspace.ts",
    "export const workspaceIpc = true;\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "packages/workbench/surface/package.json",
    '{ "name": "@tutti/workbench-surface", "version": "0.0.2" }\n'
  );
  await writeFile(
    scopePath,
    JSON.stringify(
      {
        version: 1,
        query: "workspace module",
        scopes: [
          {
            path: "apps/desktop/src/main/ipc/",
            kind: "directory"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runPlanner(workspaceRoot, [
    "--format",
    "json",
    "--no-untracked",
    "--scope-file",
    scopePath
  ]);

  assert.equal(result.status, 0, result.stderr);

  const taskPackage = JSON.parse(result.stdout);
  assert.equal(
    taskPackage.workflowEntry.scopeSelectionMode,
    "diff-intersection"
  );
  assert.equal(taskPackage.workflowEntry.scopeMode, "auto");
  assert.match(taskPackage.workflowEntry.scopeSummary, /workspace module/);
  assert.deepEqual(taskPackage.reviewScope, {
    query: "workspace module",
    keywords: [],
    strategy: "scope-file",
    scopeMode: "auto",
    selectionMode: "diff-intersection",
    scopeCount: 1,
    scopes: [
      {
        path: "apps/desktop/src/main/ipc/",
        kind: "directory"
      }
    ]
  });
  assert.deepEqual(
    taskPackage.changedFiles.map((file) => file.path),
    ["apps/desktop/src/main/ipc/workspace.ts"]
  );
  assert.deepEqual(
    taskPackage.tasks.map((task) => task.id),
    ["desktop-layering"]
  );
});

test("--scope-file falls back to scoped files when diff overlap is empty", async () => {
  const workspaceRoot = await createFixtureRepo();
  const scopePath = join(workspaceRoot, "review-scope.json");

  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/renderer/src/App.tsx",
    'import { app } from "electron";\nconsole.log(app);\n'
  );
  runGit(workspaceRoot, ["add", "apps/desktop/src/renderer/src/App.tsx"]);
  runGit(workspaceRoot, [
    "-c",
    "user.name=Tutti Test",
    "-c",
    "user.email=tutti-test@example.com",
    "commit",
    "-m",
    "update renderer app"
  ]);

  await writeFile(
    scopePath,
    JSON.stringify(
      {
        version: 1,
        query: "renderer app",
        scopes: [
          {
            path: "apps/desktop/src/renderer/src/App.tsx",
            kind: "file"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runPlanner(workspaceRoot, [
    "--format",
    "json",
    "--no-untracked",
    "--scope-file",
    scopePath
  ]);

  assert.equal(result.status, 0, result.stderr);

  const taskPackage = JSON.parse(result.stdout);
  assert.equal(taskPackage.workflowEntry.scopeSelectionMode, "scope-fallback");
  assert.equal(taskPackage.reviewScope.selectionMode, "scope-fallback");
  assert.deepEqual(
    taskPackage.changedFiles.map((file) => file.statusText),
    ["scoped"]
  );
  assert.ok(
    taskPackage.preflightSignals.some(
      (signal) => signal.id === "renderer-direct-platform-import"
    )
  );
});

test("--scope-mode static-only reviews the whole scoped area even with diff overlap", async () => {
  const workspaceRoot = await createFixtureRepo();
  const scopePath = join(workspaceRoot, "review-scope.json");

  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/main/ipc/workspace.ts",
    "export const workspaceIpc = true;\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/main/ipc/untracked.ts",
    "export const untracked = true;\n"
  );
  await writeFile(
    scopePath,
    JSON.stringify(
      {
        version: 1,
        query: "workspace ipc",
        scopes: [
          {
            path: "apps/desktop/src/main/ipc/",
            kind: "directory"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const result = runPlanner(workspaceRoot, [
    "--format",
    "json",
    "--no-untracked",
    "--scope-file",
    scopePath,
    "--scope-mode",
    "static-only"
  ]);

  assert.equal(result.status, 0, result.stderr);

  const taskPackage = JSON.parse(result.stdout);
  assert.equal(taskPackage.workflowEntry.scopeMode, "static-only");
  assert.equal(taskPackage.workflowEntry.scopeSelectionMode, "static-only");
  assert.match(taskPackage.workflowEntry.scopeSummary, /selection static-only/);
  assert.equal(taskPackage.reviewScope.scopeMode, "static-only");
  assert.deepEqual(
    taskPackage.changedFiles.map((file) => file.path),
    [
      "apps/desktop/src/main/ipc/secondary.ts",
      "apps/desktop/src/main/ipc/workspace.ts"
    ]
  );
  assert.deepEqual(
    taskPackage.changedFiles.map((file) => file.statusText),
    ["scoped", "scoped"]
  );
});

test("rejects unknown task filters with available task ids", async () => {
  const workspaceRoot = await createFixtureRepo();

  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/main/ipc/workspace.ts",
    "export const workspaceIpc = true;\n"
  );

  const result = runPlanner(workspaceRoot, [
    "--format",
    "summary",
    "--no-untracked",
    "--task",
    "missing-task"
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown --task missing-task/);
  assert.match(result.stderr, /desktop-layering/);
});

async function createFixtureRepo() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tutti-review-"));

  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/renderer/src/App.tsx",
    "console.log('renderer');\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/main/ipc/workspace.ts",
    "export const workspaceIpc = false;\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "apps/desktop/src/main/ipc/secondary.ts",
    "export const secondaryIpc = false;\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "services/tuttid/api/generated/types.gen.go",
    "package generated\n"
  );
  await writeWorkspaceFile(
    workspaceRoot,
    "packages/workbench/surface/package.json",
    '{ "name": "@tutti/workbench-surface" }\n'
  );

  runGit(workspaceRoot, ["init"]);
  await assertFixtureGitRoot(workspaceRoot);
  runGit(workspaceRoot, ["add", "."]);
  runGit(workspaceRoot, [
    "-c",
    "user.name=Tutti Test",
    "-c",
    "user.email=tutti-test@example.com",
    "commit",
    "-m",
    "fixture"
  ]);

  return workspaceRoot;
}

async function writeWorkspaceFile(workspaceRoot, path, content) {
  const absolutePath = join(workspaceRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function sampleTask(id) {
  return {
    id,
    title: `${id} reviewer`,
    area: id,
    priority: 10,
    riskLevel: "low",
    spawnRecommendation: "optional",
    triggerReasons: [],
    summaryForMainAgent: `${id}: 1 file, low risk, no preflight signals; spawn is optional.`,
    matchedFiles: [
      {
        path: "example.ts",
        statusText: "modified"
      }
    ],
    preflightSignals: [],
    referenceFiles: [],
    reviewFocus: [],
    prompt: "Review example.ts"
  };
}

function runPlanner(workspaceRoot, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: createIsolatedGitEnvironment(workspaceRoot)
  });
}

function runGit(workspaceRoot, args) {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: createIsolatedGitEnvironment(workspaceRoot)
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

async function assertFixtureGitRoot(workspaceRoot) {
  const result = runGit(workspaceRoot, ["rev-parse", "--absolute-git-dir"]);
  assert.equal(
    await realpath(result.stdout.trim()),
    await realpath(join(workspaceRoot, ".git"))
  );
}
