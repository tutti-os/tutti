import assert from "node:assert/strict";
import test from "node:test";

import { createIsolatedGitEnvironment } from "./git-environment.mjs";

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
