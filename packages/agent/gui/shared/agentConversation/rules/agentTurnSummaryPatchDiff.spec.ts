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
});
