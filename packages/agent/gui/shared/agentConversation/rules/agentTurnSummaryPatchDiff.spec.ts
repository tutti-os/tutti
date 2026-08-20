import { describe, expect, it } from "vitest";
import { buildAgentTurnSummaryPatchDiff } from "./agentTurnSummaryPatchDiff";

describe("buildAgentTurnSummaryPatchDiff", () => {
  it("wraps cwd-relative hunk diffs with git headers", () => {
    const diff = buildAgentTurnSummaryPatchDiff({
      cwd: "/workspace/project",
      toolCallId: "call-1",
      changes: [
        {
          path: "/workspace/project/src/app.ts",
          changeType: "modified",
          unifiedDiff: "@@ -1 +1 @@\n-old\n+new"
        }
      ]
    });

    expect(diff).toBe(
      "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n"
    );
  });

  it("generates add-file diffs from created content", () => {
    const diff = buildAgentTurnSummaryPatchDiff({
      cwd: "/workspace/project",
      toolCallId: "call-1",
      changes: [
        {
          path: "/workspace/project/src/new.ts",
          changeType: "created",
          content: "export const ready = true;\n"
        }
      ]
    });

    expect(diff).toBe(
      "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+export const ready = true;\n"
    );
  });

  it("makes Windows absolute paths relative to the patch cwd", () => {
    const diff = buildAgentTurnSummaryPatchDiff({
      cwd: "C:\\Users\\17940\\Documents\\tutti\\test_git",
      toolCallId: "call-1",
      changes: [
        {
          path: "C:/Users/17940/Documents/tutti/test_git/today.txt",
          changeType: "created",
          content: "2026-08-12\n"
        }
      ]
    });

    expect(diff).toBe(
      "diff --git a/today.txt b/today.txt\nnew file mode 100644\n--- /dev/null\n+++ b/today.txt\n@@ -0,0 +1,1 @@\n+2026-08-12\n"
    );
  });

  it("rebases Windows paths in complete unified diffs case-insensitively", () => {
    const absolutePath = "C:/Users/17940/Documents/tutti/test_git/today.txt";
    const diff = buildAgentTurnSummaryPatchDiff({
      cwd: "c:/users/17940/documents/tutti/test_git",
      toolCallId: "call-1",
      changes: [
        {
          path: absolutePath,
          changeType: "modified",
          unifiedDiff: [
            `diff --git a/${absolutePath} b/${absolutePath}`,
            `--- a/${absolutePath}`,
            `+++ b/${absolutePath}`,
            "@@ -1,2 +1,2 @@",
            "--- old option",
            "+++ new option",
            "-old",
            "+new"
          ].join("\n")
        }
      ]
    });

    expect(diff).toBe(
      "diff --git a/today.txt b/today.txt\n--- a/today.txt\n+++ b/today.txt\n@@ -1,2 +1,2 @@\n--- old option\n+++ new option\n-old\n+new\n"
    );
  });
});
