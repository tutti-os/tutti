import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createIsolatedGitEnvironment } from "./git-environment.mjs";

const sourceScriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "push-checked.mjs"
);

test("push-checked validates and pushes with the fetched remote lease", async () => {
  const fixture = await createFixture();
  await commitLocalChange(fixture.workspaceRoot, "local change");

  const result = runPushChecked(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    remoteHead(fixture.remoteRoot),
    localHead(fixture.workspaceRoot)
  );
  assert.equal(await readFile(fixture.pnpmLogPath, "utf8"), "run check:full\n");
  assert.match(result.stdout, /push:checked pushed/u);
});

test("push-checked rejects a dirty worktree before validation", async () => {
  const fixture = await createFixture();
  await writeFile(join(fixture.workspaceRoot, "source.txt"), "dirty\n");

  const result = runPushChecked(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /commit or stash local changes/u);
});

test("push-checked lease rejects a concurrent remote update", async () => {
  const fixture = await createFixture();
  const peerRoot = await mkdtemp(join(tmpdir(), "push-checked-peer-"));
  runGit(tmpdir(), [
    "clone",
    "--quiet",
    "--branch",
    "main",
    fixture.remoteRoot,
    peerRoot
  ]);
  await commitLocalChange(fixture.workspaceRoot, "local change");

  const result = runPushChecked(fixture, {
    TUTTI_PUSH_CHECKED_TEST_PEER: peerRoot
  });

  assert.notEqual(result.status, 0);
  assert.equal(remoteHead(fixture.remoteRoot), localHead(peerRoot));
  assert.notEqual(
    remoteHead(fixture.remoteRoot),
    localHead(fixture.workspaceRoot)
  );
  assert.match(result.stderr, /stale info/u);
});

async function createFixture() {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "push-checked-workspace-")
  );
  const remoteRoot = await mkdtemp(join(tmpdir(), "push-checked-remote-"));
  const binRoot = await mkdtemp(join(tmpdir(), "push-checked-bin-"));
  const copiedScriptPath = join(
    workspaceRoot,
    "tools/scripts/push-checked.mjs"
  );
  const pnpmPath = join(binRoot, "pnpm");
  const pnpmLogPath = join(binRoot, "pnpm.log");

  await mkdir(dirname(copiedScriptPath), { recursive: true });
  await copyFile(sourceScriptPath, copiedScriptPath);
  await writeFile(
    pnpmPath,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      "",
      'appendFileSync(process.env.TUTTI_PUSH_CHECKED_TEST_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
      "const peer = process.env.TUTTI_PUSH_CHECKED_TEST_PEER;",
      "if (peer) {",
      '  const commit = spawnSync("git", ["-C", peer, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--quiet", "--allow-empty", "-m", "concurrent"], { encoding: "utf8" });',
      "  if (commit.status !== 0) process.exit(commit.status ?? 1);",
      '  const push = spawnSync("git", ["-C", peer, "push", "--quiet", "origin", "HEAD:main"], { encoding: "utf8" });',
      "  if (push.status !== 0) process.exit(push.status ?? 1);",
      "}",
      ""
    ].join("\n")
  );
  await chmod(pnpmPath, 0o755);

  runGit(remoteRoot, ["init", "--bare", "--quiet"]);
  runGit(workspaceRoot, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(workspaceRoot, "source.txt"), "initial\n");
  runGit(workspaceRoot, ["add", "."]);
  commit(workspaceRoot, "initial");
  runGit(workspaceRoot, ["remote", "add", "origin", remoteRoot]);
  runGit(workspaceRoot, [
    "push",
    "--quiet",
    "--set-upstream",
    "origin",
    "main"
  ]);
  runGit(remoteRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  return {
    binRoot,
    copiedScriptPath,
    pnpmLogPath,
    remoteRoot,
    workspaceRoot
  };
}

async function commitLocalChange(workspaceRoot, message) {
  await writeFile(join(workspaceRoot, "source.txt"), `${message}\n`);
  runGit(workspaceRoot, ["add", "source.txt"]);
  commit(workspaceRoot, message);
}

function commit(workspaceRoot, message) {
  runGit(workspaceRoot, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--quiet",
    "-m",
    message
  ]);
}

function runPushChecked(fixture, extraEnv = {}) {
  return spawnSync(process.execPath, [fixture.copiedScriptPath], {
    cwd: fixture.workspaceRoot,
    encoding: "utf8",
    env: createIsolatedGitEnvironment(fixture.workspaceRoot, {
      ...process.env,
      ...extraEnv,
      PATH: `${fixture.binRoot}:${process.env.PATH ?? ""}`,
      TUTTI_PUSH_CHECKED_TEST_LOG: fixture.pnpmLogPath
    })
  });
}

function localHead(workspaceRoot) {
  return runGit(workspaceRoot, ["rev-parse", "HEAD"]).stdout.trim();
}

function remoteHead(remoteRoot) {
  return runGit(remoteRoot, ["rev-parse", "refs/heads/main"]).stdout.trim();
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createIsolatedGitEnvironment(cwd)
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
