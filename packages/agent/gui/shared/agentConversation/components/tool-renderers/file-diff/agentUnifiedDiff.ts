import {
  extractAgentPatchPath,
  inferAgentPatchChangeType,
  normalizeAgentPatchText,
  type AgentPatchChangeType
} from "../../../rules/agentPatchMetadata";
import { isAgentUnifiedDiffText } from "../../../rules/agentUnifiedDiffValidation";

export { extractAgentPatchPath, inferAgentPatchChangeType };
export type AgentUnifiedDiffChangeType = AgentPatchChangeType;

export interface ParsedAgentUnifiedDiff {
  oldString: string;
  newString: string;
}

export interface ParsedAgentUnifiedDiffLine {
  kind: "add" | "remove" | "context";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
}

export type AgentFileChangeType =
  | "created"
  | "modified"
  | "deleted"
  | "unknown";

const DIFF_META_PREFIXES = [
  "diff --git ",
  "index ",
  "--- ",
  "+++ ",
  "*** "
] as const;

export function parseAgentUnifiedDiff(
  diffText: string
): ParsedAgentUnifiedDiff | null {
  if (!isAgentUnifiedDiff(diffText)) {
    return null;
  }

  const normalizedText = normalizeAgentPatchText(diffText);
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let sawChangeLine = false;
  let sawHunkHeader = false;
  let hunkActive = false;

  for (const line of normalizedText.replace(/\r\n/g, "\n").split("\n")) {
    if (/^@@(?: -\d|$)/.test(line)) {
      if (sawHunkHeader && (oldLines.length > 0 || newLines.length > 0)) {
        oldLines.push("");
        newLines.push("");
      }
      sawHunkHeader = true;
      hunkActive = true;
      continue;
    }
    if (line === "@@" && isApplyPatch(normalizedText)) {
      if (sawHunkHeader && (oldLines.length > 0 || newLines.length > 0)) {
        oldLines.push("");
        newLines.push("");
      }
      sawHunkHeader = true;
      hunkActive = true;
      continue;
    }
    if (hunkActive && line.startsWith("diff --git ")) {
      hunkActive = false;
      continue;
    }
    if (
      (!hunkActive &&
        DIFF_META_PREFIXES.some((prefix) => line.startsWith(prefix))) ||
      (hunkActive && isApplyPatch(normalizedText) && line.startsWith("*** "))
    ) {
      continue;
    }
    if (line === "\\ No newline at end of file") {
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      sawChangeLine = true;
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      sawChangeLine = true;
      continue;
    }
    if (line.startsWith(" ")) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
    }
  }

  if (!sawChangeLine) {
    return null;
  }

  return {
    oldString: oldLines.join("\n"),
    newString: newLines.join("\n")
  };
}

export function parseAgentUnifiedDiffLines(
  diffText: string
): ParsedAgentUnifiedDiffLine[] {
  if (!isAgentUnifiedDiff(diffText)) {
    return [];
  }
  const normalized = normalizeAgentPatchText(diffText);
  if (!normalized.trim()) {
    return [];
  }

  const lines: ParsedAgentUnifiedDiffLine[] = [];
  let oldLineNumber = 0;
  let newLineNumber = 0;
  let hunkActive = false;

  for (const line of normalized.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (match) {
      oldLineNumber = Number.parseInt(match[1] ?? "0", 10);
      newLineNumber = Number.parseInt(match[2] ?? "0", 10);
      hunkActive = true;
      continue;
    }
    if (line === "@@" && isApplyPatch(normalized)) {
      hunkActive = true;
      continue;
    }
    if (hunkActive && line.startsWith("diff --git ")) {
      hunkActive = false;
      continue;
    }
    if (
      (!hunkActive &&
        DIFF_META_PREFIXES.some((prefix) => line.startsWith(prefix))) ||
      (hunkActive && isApplyPatch(normalized) && line.startsWith("*** "))
    ) {
      continue;
    }
    if (line === "\\ No newline at end of file") {
      continue;
    }
    if (line.startsWith("+")) {
      lines.push({
        kind: "add",
        oldLineNumber: null,
        newLineNumber,
        text: line.slice(1)
      });
      newLineNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      lines.push({
        kind: "remove",
        oldLineNumber,
        newLineNumber: null,
        text: line.slice(1)
      });
      oldLineNumber += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      lines.push({
        kind: "context",
        oldLineNumber,
        newLineNumber,
        text: line.slice(1)
      });
      oldLineNumber += 1;
      newLineNumber += 1;
    }
  }

  return lines;
}

export function isAgentUnifiedDiff(diffText: string): boolean {
  return isAgentUnifiedDiffText(diffText);
}

export function countAgentTextLines(value: string | null | undefined): number {
  if (typeof value !== "string" || value.length === 0) {
    return 0;
  }
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}

export function agentFileChangeStats({
  changeType,
  unifiedDiff,
  content,
  oldString,
  newString
}: {
  changeType: AgentFileChangeType;
  unifiedDiff: string | null | undefined;
  content: string | null | undefined;
  oldString: string | null | undefined;
  newString: string | null | undefined;
}): { added: number; removed: number } {
  const diff = typeof unifiedDiff === "string" ? unifiedDiff : null;
  if (diff && isAgentUnifiedDiff(diff)) {
    return parseAgentUnifiedDiffStats(diff);
  }

  if (changeType === "deleted") {
    return {
      added: 0,
      removed: countAgentTextLines(oldString ?? content ?? diff)
    };
  }
  if (changeType === "created") {
    return {
      added: countAgentTextLines(content ?? newString ?? diff),
      removed: 0
    };
  }
  if (typeof oldString === "string" && typeof newString === "string") {
    return agentTextDiffStats(oldString, newString);
  }
  return { added: 0, removed: 0 };
}

export function parseAgentUnifiedDiffStats(diffText: string): {
  added: number;
  removed: number;
} {
  if (!isAgentUnifiedDiff(diffText)) {
    return { added: 0, removed: 0 };
  }

  let added = 0;
  let removed = 0;
  let hunkActive = false;
  const normalized = normalizeAgentPatchText(diffText);
  for (const line of normalized.replace(/\r\n/g, "\n").split("\n")) {
    if (/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.test(line)) {
      hunkActive = true;
      continue;
    }
    if (line === "@@" && isApplyPatch(normalized)) {
      hunkActive = true;
      continue;
    }
    if (hunkActive && line.startsWith("diff --git ")) {
      hunkActive = false;
      continue;
    }
    if (
      (!hunkActive &&
        DIFF_META_PREFIXES.some((prefix) => line.startsWith(prefix))) ||
      (hunkActive && isApplyPatch(normalized) && line.startsWith("*** "))
    ) {
      continue;
    }
    if (line === "\\ No newline at end of file" || !hunkActive) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function agentTextDiffStats(
  oldString: string,
  newString: string
): { added: number; removed: number } {
  const oldLines = splitAgentTextLines(oldString);
  const newLines = splitAgentTextLines(newString);
  if (oldLines.length === 0 && newLines.length === 0) {
    return { added: 0, removed: 0 };
  }
  if (oldLines.length * newLines.length > 2_000_000) {
    return { added: 0, removed: 0 };
  }

  let previous = Array.from({ length: newLines.length + 1 }, () => 0);
  for (const oldLine of oldLines) {
    const current = Array.from({ length: newLines.length + 1 }, () => 0);
    for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
      current[newIndex] =
        oldLine === newLines[newIndex - 1]
          ? previous[newIndex - 1]! + 1
          : Math.max(previous[newIndex]!, current[newIndex - 1]!);
    }
    previous = current;
  }

  const commonLines = previous[newLines.length] ?? 0;
  return {
    added: newLines.length - commonLines,
    removed: oldLines.length - commonLines
  };
}

function splitAgentTextLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function isApplyPatch(value: string): boolean {
  return (
    value.includes("*** Begin Patch") &&
    (value.includes("*** Add File:") ||
      value.includes("*** Delete File:") ||
      value.includes("*** Update File:"))
  );
}
