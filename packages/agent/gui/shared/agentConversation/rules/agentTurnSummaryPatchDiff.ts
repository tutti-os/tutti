import type {
  AgentTurnSummaryPatchBatchVM,
  AgentTurnSummaryPatchChangeVM
} from "../contracts/agentTurnSummaryRowVM";
import {
  isInsideOrEqualWorkspaceFilePath,
  normalizeWorkspaceFilePath
} from "../../../actions/workspaceFilePathCandidate";
import { normalizeAgentPatchText } from "./agentPatchMetadata";
import { isAgentUnifiedDiffText } from "./agentUnifiedDiffValidation";

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
  if (rawDiff && isAgentUnifiedDiffText(rawDiff)) {
    return ensureTrailingNewline(
      wrapUnifiedDiff(path, change.changeType, rawDiff, cwd)
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
  if (change.oldString != null && change.newString != null) {
    return modifiedFilePatch(
      path,
      change.oldString,
      change.newString
    );
  }
  return "";
}

function wrapUnifiedDiff(
  path: string,
  changeType: AgentTurnSummaryPatchChangeVM["changeType"],
  diff: string,
  cwd: string | null
): string {
  if (diff.startsWith("diff --git ")) {
    return rebaseUnifiedDiffPaths(diff, cwd);
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

function rebaseUnifiedDiffPaths(diff: string, cwd: string | null): string {
  let inHunk = false;
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        inHunk = false;
      } else if (line.startsWith("@@ ")) {
        inHunk = true;
        return line;
      } else if (inHunk) {
        return line;
      }

      const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (gitHeader?.[1] && gitHeader[2]) {
        return `diff --git a/${patchPathRelativeToCwd(
          gitHeader[1],
          cwd
        )} b/${patchPathRelativeToCwd(gitHeader[2], cwd)}`;
      }

      const fileHeader = line.match(/^(---|\+\+\+) ((?:a\/|b\/)?)(.+)$/);
      const [, marker, prefix, filePath] = fileHeader ?? [];
      if (
        !marker ||
        prefix === undefined ||
        !filePath ||
        filePath === "/dev/null"
      ) {
        return line;
      }
      return `${marker} ${prefix}${patchPathRelativeToCwd(filePath, cwd)}`;
    })
    .join("\n");
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
  const normalizedCwd = normalizeWorkspaceFilePath(cwd ?? "");
  const normalizedPath = normalizeWorkspaceFilePath(path, normalizedCwd);
  if (
    isAbsolutePatchPath(normalizedPath) &&
    normalizedCwd &&
    isInsideOrEqualWorkspaceFilePath(normalizedPath, normalizedCwd)
  ) {
    const relativePath = normalizedPath
      .slice(normalizedCwd.length)
      .replace(/^\/+/, "");
    if (relativePath) {
      return relativePath;
    }
  }
  return normalizedPath.replace(/^\/+/, "");
}

function isAbsolutePatchPath(path: string): boolean {
  return path.startsWith("/") || /^\/?[A-Za-z]:\//.test(path);
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
