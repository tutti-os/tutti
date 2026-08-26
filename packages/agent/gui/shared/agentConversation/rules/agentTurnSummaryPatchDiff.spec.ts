import { describe, expect, it } from "vitest";
import { buildAgentTurnSummaryPatchDiff } from "./agentTurnSummaryPatchDiff";
import { isAgentUnifiedDiffText } from "./agentUnifiedDiffValidation";

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

  it("builds a valid zero-old-count patch for the reported Kimi empty-file edit", () => {
    const content =
      "这是一个示例文本文件。\n\n当前时间：2026-08-20\n用途：测试文件创建\n\n你可以随时修改或删除此文件。";
    const diff = buildAgentTurnSummaryPatchDiff({
      cwd: "C:/Users/17940/Documents/tutti/test_git",
      toolCallId: "kimi-create-note",
      changes: [
        {
          path: "C:/Users/17940/Documents/tutti/test_git/note.txt",
          changeType: "modified",
          oldString: "",
          newString: content
        }
      ]
    });

    expect(new TextEncoder().encode(content)).toHaveLength(132);
    expect(new TextEncoder().encode(diff)).toHaveLength(218);
    expect(diff).toContain("@@ -0,0 +1,6 @@");
    expect(isAgentUnifiedDiffText(diff)).toBe(true);
  });

  it("normalizes CRLF while preserving a valid zero-new-count patch", () => {
    const diff = buildAgentTurnSummaryPatchDiff({
      cwd: "/workspace/project",
      toolCallId: "clear-file",
      changes: [
        {
          path: "/workspace/project/note.txt",
          changeType: "modified",
          oldString: "first\r\nsecond\r\n",
          newString: ""
        }
      ]
    });

    expect(diff).toContain("@@ -1,2 +0,0 @@");
    expect(diff).not.toContain("\r");
    expect(isAgentUnifiedDiffText(diff)).toBe(true);
  });

  it("fails closed for binary content without an executable binary diff", () => {
    const diff = buildAgentTurnSummaryPatchDiff({
      cwd: "/workspace/project",
      toolCallId: "binary-write",
      changes: [
        {
          path: "/workspace/project/image.bin",
          changeType: "modified",
          oldString: "old\0bytes",
          newString: "new\0bytes"
        }
      ]
    });

    expect(diff).toBe("");
  });

  it.each([
    ["created", "0000000..e69de29"],
    ["deleted", "e69de29..0000000"]
  ] as const)("builds an exact %s empty-file patch", (changeType, index) => {
    const diff = buildAgentTurnSummaryPatchDiff({
      cwd: "/workspace/project",
      toolCallId: `empty-${changeType}`,
      changes: [
        {
          path: "/workspace/project/empty.txt",
          changeType,
          ...(changeType === "created"
            ? { newString: "", content: "" }
            : { oldString: "", content: "" })
        }
      ]
    });

    expect(diff).toContain(`index ${index}`);
    expect(diff).not.toContain("@@");
  });
  it.each([
    { oldString: "before\n", newString: undefined },
    { oldString: undefined, newString: "after\n" }
  ])(
    "does not invent a modified-file patch from one-sided content",
    (change) => {
      const diff = buildAgentTurnSummaryPatchDiff({
        cwd: "/workspace/project",
        toolCallId: "call-1",
        changes: [
          {
            path: "/workspace/project/src/app.ts",
            changeType: "modified",
            ...change
          }
        ]
      });

      expect(diff).toBe("");
    }
  );
});
