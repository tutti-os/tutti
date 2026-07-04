import type {
  AgentTurnSummaryPatchBatchVM,
  AgentTurnSummaryPatchChangeVM
} from "../contracts/agentTurnSummaryRowVM";
import { normalizeAgentPatchText } from "./agentPatchMetadata";

export function buildAgentTurnSummaryPatchDiff(
  batch: AgentTurnSummaryPatchBatchVM
): string {
  return batch.changes
    .map((change) => patchChangeToUnifiedDiff(change, batch.cwd))
    .filter((diff) => diff.trim().length > 0)
    .join("\n");
}

function patchChangeToUnifiedDiff(
  change: AgentTurnSummaryPatchChangeVM,
  cwd: string | null
): string {
  const path = patchPathRelativeToCwd(change.path, cwd);
  const rawDiff = normalizeAgentPatchText(change.unifiedDiff ?? "").trim();
  if (rawDiff && looksLikeUnifiedDiff(rawDiff)) {
    return ensureTrailingNewline(
      wrapUnifiedDiff(path, change.changeType, rawDiff)
    );
  }
  if (change.changeType === "created") {
    return fileContentPatch(
      path,
      "created",
      change.content ?? change.newString ?? rawDiff
    );
  }
  if (change.changeType === "deleted") {
    return fileContentPatch(
      path,
      "deleted",
      change.oldString ?? change.content ?? rawDiff
    );
  }
  if (change.oldString != null || change.newString != null) {
    return modifiedFilePatch(
      path,
      change.oldString ?? "",
      change.newString ?? ""
    );
  }
  return "";
}

function wrapUnifiedDiff(
  path: string,
  changeType: AgentTurnSummaryPatchChangeVM["changeType"],
  diff: string
): string {
  if (diff.startsWith("diff --git ")) {
    return diff;
  }
  const headers = [`diff --git a/${path} b/${path}`];
  if (changeType === "created") {
    headers.push("new file mode 100644", "--- /dev/null", `+++ b/${path}`);
  } else if (changeType === "deleted") {
    headers.push("deleted file mode 100644", `--- a/${path}`, "+++ /dev/null");
  } else if (!diff.startsWith("--- ") && !diff.includes("\n--- ")) {
    headers.push(`--- a/${path}`, `+++ b/${path}`);
  }
  return [...headers, diff].join("\n");
}

function fileContentPatch(
  path: string,
  changeType: "created" | "deleted",
  content: string
): string {
  const lines = splitPatchContentLines(content);
  const count = Math.max(lines.length, 1);
  const prefix = changeType === "created" ? "+" : "-";
  const body =
    lines.length > 0 ? lines.map((line) => `${prefix}${line}`) : [`${prefix}`];
  const header =
    changeType === "created"
      ? [
          `diff --git a/${path} b/${path}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${path}`,
          `@@ -0,0 +1,${count} @@`
        ]
      : [
          `diff --git a/${path} b/${path}`,
          "deleted file mode 100644",
          `--- a/${path}`,
          "+++ /dev/null",
          `@@ -1,${count} +0,0 @@`
        ];
  return ensureTrailingNewline([...header, ...body].join("\n"));
}

function modifiedFilePatch(
  path: string,
  oldContent: string,
  newContent: string
): string {
  const oldLines = splitPatchContentLines(oldContent);
  const newLines = splitPatchContentLines(newContent);
  const oldCount = Math.max(oldLines.length, 1);
  const newCount = Math.max(newLines.length, 1);
  return ensureTrailingNewline(
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${oldCount} +1,${newCount} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`)
    ].join("\n")
  );
}

function patchPathRelativeToCwd(path: string, cwd: string | null): string {
  const normalizedPath = normalizePathForPatch(path);
  const normalizedCwd = normalizePathForPatch(cwd ?? "");
  if (
    normalizedPath.startsWith("/") &&
    normalizedCwd &&
    normalizedPath.startsWith(`${normalizedCwd}/`)
  ) {
    return normalizedPath.slice(normalizedCwd.length + 1);
  }
  return normalizedPath.replace(/^\/+/, "");
}

function normalizePathForPatch(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
}

function looksLikeUnifiedDiff(value: string): boolean {
  return (
    value.startsWith("diff --git ") ||
    value.startsWith("@@ ") ||
    value.startsWith("--- ") ||
    value.includes("\n@@ ")
  );
}

function splitPatchContentLines(content: string): string[] {
  if (!content) {
    return [];
  }
  return content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
