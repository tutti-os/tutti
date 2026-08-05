import { describe, expect, it } from "vitest";
import {
  agentFileChangeStats,
  countAgentTextLines,
  isAgentUnifiedDiff,
  parseAgentUnifiedDiff,
  parseAgentUnifiedDiffLines,
  parseAgentUnifiedDiffStats
} from "./agentUnifiedDiff";

describe("agentUnifiedDiff", () => {
  const diffText = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const ready = false",
    "+const ready = true",
    " export const value = 1"
  ].join("\n");

  it("parses unified diff into old/new strings", () => {
    expect(parseAgentUnifiedDiff(diffText)).toEqual({
      oldString: "const ready = false\nexport const value = 1",
      newString: "const ready = true\nexport const value = 1"
    });
  });

  it("parses added/removed diff stats", () => {
    expect(parseAgentUnifiedDiffStats(diffText)).toEqual({
      added: 1,
      removed: 1
    });
  });

  it("does not treat file content as a unified diff", () => {
    const content = [
      "# 你好，我是 Liying 👋",
      "",
      "欢迎来到我的个人主页！",
      "",
      "我是 Liying。",
      "",
      "- 👤 名字：Liying",
      "- 🌱 正在持续学习与成长",
      "- ✨ 喜欢尝试新事物、记录想法"
    ].join("\n");

    expect(isAgentUnifiedDiff(content)).toBe(false);
    expect(parseAgentUnifiedDiffStats(content)).toEqual({
      added: 0,
      removed: 0
    });
    expect(
      agentFileChangeStats({
        changeType: "created",
        unifiedDiff: content,
        content: null,
        oldString: null,
        newString: null
      })
    ).toEqual({ added: 9, removed: 0 });
  });

  it("rejects pseudo hunk headers", () => {
    expect(isAgentUnifiedDiff("@@ notes\n- bullet")).toBe(false);
    expect(parseAgentUnifiedDiffStats("@@ notes\n- bullet")).toEqual({
      added: 0,
      removed: 0
    });
  });

  it("counts blank lines consistently with file content", () => {
    expect(countAgentTextLines("first\n\nthird\n")).toBe(3);
    expect(countAgentTextLines("\n")).toBe(1);
    expect(countAgentTextLines("   ")).toBe(1);
  });

  it("does not count an invalid modified body as additions", () => {
    expect(
      agentFileChangeStats({
        changeType: "modified",
        unifiedDiff: "README\n- bullet\n",
        content: null,
        oldString: null,
        newString: null
      })
    ).toEqual({ added: 0, removed: 0 });
  });

  it("computes conservative stats for modified text bodies", () => {
    expect(
      agentFileChangeStats({
        changeType: "modified",
        unifiedDiff: null,
        content: null,
        oldString: "one\ntwo\n",
        newString: "one\nthree\n"
      })
    ).toEqual({ added: 1, removed: 1 });
  });

  it("parses unified diff into numbered display lines", () => {
    expect(parseAgentUnifiedDiffLines(diffText)).toEqual([
      {
        kind: "remove",
        oldLineNumber: 1,
        newLineNumber: null,
        text: "const ready = false"
      },
      {
        kind: "add",
        oldLineNumber: null,
        newLineNumber: 1,
        text: "const ready = true"
      },
      {
        kind: "context",
        oldLineNumber: 2,
        newLineNumber: 2,
        text: "export const value = 1"
      }
    ]);
  });

  it("parses deleted git diff stats", () => {
    const deletedDiff = [
      "diff --git a/a.md b/a.md",
      "deleted file mode 100644",
      "--- a/a.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-aaaaa"
    ].join("\n");

    expect(parseAgentUnifiedDiffStats(deletedDiff)).toEqual({
      added: 0,
      removed: 1
    });
  });

  it("parses deleted apply_patch stats", () => {
    const deletedPatch = [
      "*** Begin Patch",
      "*** Delete File: a.md",
      "@@",
      "-aaaaa",
      "*** End Patch"
    ].join("\n");

    expect(parseAgentUnifiedDiffStats(deletedPatch)).toEqual({
      added: 0,
      removed: 1
    });
  });

  it("handles escaped newline JSON payload wrappers", () => {
    const wrapped = JSON.stringify({ content: diffText.replace(/\n/g, "\\n") });
    expect(parseAgentUnifiedDiff(wrapped)).toEqual({
      oldString: "const ready = false\nexport const value = 1",
      newString: "const ready = true\nexport const value = 1"
    });
  });
});
