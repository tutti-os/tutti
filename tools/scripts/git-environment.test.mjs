import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createIsolatedGitEnvironment } from "./git-environment.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

test("isolates Git repository selectors case-insensitively", () => {
  const fixtureRoot = "/tmp/tutti-git-fixture";
  const env = createIsolatedGitEnvironment(fixtureRoot, {
    Git_Alternate_Object_Directories: "/poison/objects",
    git_ceiling_directories: "/poison/ceiling",
    Git_Common_Dir: "/poison/common",
    git_config_count: "1",
    Git_Config_Key_0: "core.bare",
    git_config_value_0: "true",
    git_dir: "/poison/git-dir",
    Git_Index_File: "/poison/index",
    git_work_tree: "/poison/worktree",
    PRESERVED_FIXTURE_VALUE: "preserved"
  });

  assert.deepEqual(env, {
    GIT_CEILING_DIRECTORIES: fixtureRoot,
    PRESERVED_FIXTURE_VALUE: "preserved"
  });
});

test("temporary Git fixture tests preserve an inherited linked worktree", () => {
  for (const testFile of [
    "push-checked.test.mjs",
    "run-check-changed.test.mjs"
  ]) {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "tutti-git-isolation-"));
    const primaryRoot = join(fixtureRoot, "primary");
    const linkedRoot = join(fixtureRoot, "linked");
    mkdirSync(primaryRoot);
    runGit(fixtureRoot, [
      "init",
      "--quiet",
      "--initial-branch=main",
      primaryRoot
    ]);
    runGit(primaryRoot, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "initial"
    ]);
    runGit(primaryRoot, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "fixture",
      linkedRoot
    ]);

    const linkedGitDirectory = gitOutput(linkedRoot, [
      "rev-parse",
      "--absolute-git-dir"
    ]);
    const configPath = join(primaryRoot, ".git", "config");
    const configBefore = readFileSync(configPath, "utf8");
    const headBefore = gitOutput(linkedRoot, ["rev-parse", "HEAD"]);
    const childEnvironment = createIsolatedGitEnvironment(linkedRoot);
    delete childEnvironment.NODE_TEST_CONTEXT;
    childEnvironment.GIT_DIR = linkedGitDirectory;
    const result = spawnSync(
      process.execPath,
      ["--test", join(scriptDirectory, testFile)],
      {
        cwd: scriptDirectory,
        encoding: "utf8",
        env: childEnvironment
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(configPath, "utf8"), configBefore, testFile);
    assert.equal(gitOutput(linkedRoot, ["rev-parse", "HEAD"]), headBefore);
  }
});

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createIsolatedGitEnvironment(cwd)
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function gitOutput(cwd, args) {
  return runGit(cwd, args).stdout.trim();
}
