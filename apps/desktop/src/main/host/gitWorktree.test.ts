import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createDesktopGitWorktree } from "./gitWorktree.ts";

test("creates a stable worktree and task branch beside the repository", async () => {
  const calls: Array<{ args: readonly string[]; file: string }> = [];
  const result = await createDesktopGitWorktree(
    {
      issueId: "issue/1",
      sourceDirectory: "/projects/product/src",
      taskId: "task:1"
    },
    {
      execFile: async (file, args) => {
        calls.push({ args, file });
        if (args.includes("rev-parse")) {
          return { stderr: "", stdout: "/projects/product\n" };
        }
        if (args.includes("list")) return { stderr: "", stdout: "" };
        return { stderr: "", stdout: "" };
      }
    }
  );

  assert.deepEqual(result, {
    branch: "tutti/issue-issue-1-task-1",
    path: path.join("/projects", "product-tutti-issue-1-task-1")
  });
  assert.deepEqual(calls.at(-1), {
    file: "git",
    args: [
      "-C",
      "/projects/product",
      "worktree",
      "add",
      "-b",
      "tutti/issue-issue-1-task-1",
      path.join("/projects", "product-tutti-issue-1-task-1"),
      "HEAD"
    ]
  });
});

test("returns an existing task worktree on retry", async () => {
  const result = await createDesktopGitWorktree(
    {
      issueId: "issue-1",
      sourceDirectory: "/projects/product",
      taskId: "task-1"
    },
    {
      execFile: async (_file, args) => {
        if (args.includes("rev-parse")) {
          return { stderr: "", stdout: "/projects/product\n" };
        }
        return {
          stderr: "",
          stdout:
            "worktree /projects/product\nHEAD deadbeef\n\nworktree /projects/product-tutti-issue-1-task-1\nHEAD deadbeef\n"
        };
      }
    }
  );

  assert.equal(result?.path, "/projects/product-tutti-issue-1-task-1");
});

test("does not require a worktree for a non-Git source directory", async () => {
  const result = await createDesktopGitWorktree(
    {
      issueId: "issue-1",
      sourceDirectory: "/projects/plain-files",
      taskId: "task-1"
    },
    {
      execFile: async () => {
        throw new Error(
          "fatal: not a git repository (or any of the parent directories): .git"
        );
      }
    }
  );

  assert.equal(result, null);
});
