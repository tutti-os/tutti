import { resolveWorkspaceFilePathCandidate } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentTurnSummaryFileVM } from "../contracts/agentTurnSummaryRowVM";
import { inferAgentPatchChangeType } from "../rules/agentPatchMetadata";
import {
  fileChangeEntriesFromChanges,
  fileChangeTypeValue
} from "../../workspaceAgentFileChangePayload";

export type AgentTurnSummaryChangeType = AgentTurnSummaryFileVM["changeType"];
export interface AgentTurnSummaryProjectionOptions {
  defaultCwd?: string | null;
  workspaceRoot?: string | null;
}

export function collectContentDiffFiles(
  messageId: string,
  toolName: string | null,
  occurredAtUnixMs: number | null,
  contentItems: unknown[] | null,
  changes: unknown,
  options: AgentTurnSummaryProjectionOptions
): AgentTurnSummaryFileVM[] {
  if (!contentItems) {
    return [];
  }
  const changesByPath = new Map(
    fileChangeEntriesFromChanges(changes).map((entry) => [
      entry.path,
      entry.change
    ])
  );
  return contentItems.flatMap((value, index) => {
    const item = objectValue(value);
    if (!item) {
      return [];
    }
    const type = stringValue(item.type);
    if (type && type !== "diff") {
      return [];
    }
    const path = normalizedFilePath(stringValue(item.path), options);
    if (!path) {
      return [];
    }
    const relatedChange = changesByPath.get(path) ?? null;
    const normalizedType = normalizeChangeType(
      relatedChange ? fileChangeTypeValue(relatedChange) : null
    );
    const unifiedDiff = firstNonEmptyString(
      stringValue(item.diff),
      stringValue(item.patch),
      stringValue(relatedChange?.unified_diff),
      stringValue(relatedChange?.unifiedDiff)
    );
    let oldString = firstPresentString(
      literalStringValue(item.oldText),
      literalStringValue(item.oldString),
      literalStringValue(relatedChange?.old_string),
      literalStringValue(relatedChange?.oldString)
    );
    const relatedContent = literalStringValue(relatedChange?.content);
    let newString = firstPresentString(
      literalStringValue(item.newText),
      literalStringValue(item.newString),
      literalStringValue(relatedChange?.new_string),
      literalStringValue(relatedChange?.newString),
      relatedContent
    );
    if (
      normalizedType === "created" &&
      oldString === null &&
      newString !== null
    ) {
      oldString = "";
    }
    if (
      normalizedType === "deleted" &&
      oldString === null &&
      newString !== null
    ) {
      oldString = newString;
      newString = "";
    }
    if (
      normalizedType === "deleted" &&
      newString === null &&
      oldString !== null
    ) {
      newString = "";
    }
    const explicitContent = firstPresentString(
      literalStringValue(item.content),
      relatedContent
    );
    const inferredType =
      normalizedType ??
      inferChangeTypeFromToolContent(
        toolName,
        normalizedType === "deleted" ? null : explicitContent,
        oldString,
        newString
      );
    if (
      inferredType === "created" &&
      oldString === null &&
      newString !== null
    ) {
      oldString = "";
    }
    const content = firstPresentString(
      inferredType === "deleted" ? null : explicitContent,
      inferredType === "created" ? newString : null
    );
    if (
      !unifiedDiff &&
      oldString === null &&
      newString === null &&
      content === null
    ) {
      return [];
    }
    return [
      buildFileChange({
        id: `${messageId}:content:${index + 1}`,
        toolName,
        path,
        changeType: inferredType ?? inferAgentPatchChangeType(unifiedDiff),
        unifiedDiff,
        oldString,
        newString,
        content,
        occurredAtUnixMs
      })
    ];
  });
}

export function buildFileChange(input: {
  id: string;
  toolName: string | null;
  path: string;
  changeType: AgentTurnSummaryChangeType;
  unifiedDiff: string | null;
  oldString: string | null;
  newString: string | null;
  content: string | null;
  occurredAtUnixMs: number | null;
}): AgentTurnSummaryFileVM {
  const parts = splitFilePath(input.path);
  return {
    label: input.path,
    path: input.path,
    fileName: parts.fileName,
    directory: parts.directory,
    changeType: input.changeType,
    toolName: input.toolName,
    messageId: input.id,
    unifiedDiff: input.unifiedDiff,
    oldString: input.oldString,
    newString: input.newString,
    content: input.content,
    occurredAtUnixMs: input.occurredAtUnixMs
  };
}

export function normalizedFilePath(
  value: string | null,
  options: AgentTurnSummaryProjectionOptions = {}
): string | null {
  const path = value?.trim() ?? "";
  if (!path || isStructuredPayloadPath(path) || isIgnoredFilePath(path)) {
    return null;
  }
  return resolveWorkspaceFilePathCandidate({
    path,
    workspaceRoot: options.workspaceRoot
  })
    ? path
    : null;
}

export function isIgnoredFilePath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath === "/dev/null" || normalizedPath === "NUL";
}

export function isStructuredPayloadPath(path: string): boolean {
  if (/[\r\n]/.test(path)) {
    return true;
  }
  if (!path.startsWith("{") && !path.startsWith("[")) {
    return false;
  }
  try {
    JSON.parse(path);
    return true;
  } catch {
    return false;
  }
}

export function dedupeFiles(
  files: AgentTurnSummaryFileVM[]
): AgentTurnSummaryFileVM[] {
  const byPath = new Map<string, AgentTurnSummaryFileVM>();
  files.forEach((file) => {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, file);
      return;
    }
    if (existing.changeType === "deleted" && file.changeType === "created") {
      byPath.set(file.path, {
        ...file,
        changeType: "modified",
        unifiedDiff: null,
        oldString:
          existing.oldString ??
          existing.content ??
          existing.unifiedDiff ??
          null,
        newString: file.newString ?? file.content ?? file.unifiedDiff ?? null,
        content: null
      });
      return;
    }
    if (file.changeType === "deleted" || existing.changeType === "deleted") {
      byPath.set(file.path, file);
      return;
    }
    if (existing.changeType === "modified" && file.changeType === "created") {
      byPath.set(file.path, file);
      return;
    }
    if (detailScore(file) > detailScore(existing)) {
      byPath.set(file.path, file);
    }
  });
  return [...byPath.values()];
}

export function applyShortestUniqueFileLabels(
  files: AgentTurnSummaryFileVM[]
): AgentTurnSummaryFileVM[] {
  const suffixByPath = shortestUniquePathSuffixByPath(
    files.map((file) => file.path)
  );
  return files.map((file) => ({
    ...file,
    label: suffixByPath.get(file.path) ?? file.label
  }));
}

export function shortestUniquePathSuffixByPath(
  paths: string[]
): Map<string, string> {
  const partsByPath = new Map(
    paths.map((path) => [path, splitPathSegments(path)])
  );
  const labels = new Map<string, string>();
  const unresolved = new Set(paths);

  for (let depth = 1; unresolved.size > 0; depth += 1) {
    const grouped = new Map<string, string[]>();

    for (const path of unresolved) {
      const parts = partsByPath.get(path) ?? [];
      const suffix = parts.slice(-Math.min(depth, parts.length)).join("/");
      const fallback = parts.at(-1) ?? path;
      const label = suffix || fallback;
      const group = grouped.get(label);
      if (group) {
        group.push(path);
      } else {
        grouped.set(label, [path]);
      }
    }

    let resolvedCount = 0;
    for (const [label, group] of grouped) {
      if (group.length !== 1) {
        continue;
      }
      const path = group[0];
      if (!path) {
        continue;
      }
      labels.set(path, label);
      unresolved.delete(path);
      resolvedCount += 1;
    }

    if (resolvedCount === 0) {
      for (const path of unresolved) {
        labels.set(path, path);
      }
      break;
    }
  }

  return labels;
}

export function detailScore(file: AgentTurnSummaryFileVM): number {
  let score = 0;
  if (file.unifiedDiff) {
    score += 4;
  }
  if (file.oldString || file.newString) {
    score += 3;
  }
  if (file.content) {
    score += 2;
  }
  if (file.toolName) {
    score += 1;
  }
  return score;
}

export function splitFilePath(path: string): {
  fileName: string;
  directory: string | null;
} {
  const normalized = path.trim();
  const parts = splitPathSegments(normalized);
  if (parts.length <= 1) {
    return { fileName: parts[0] ?? normalized, directory: null };
  }
  return {
    fileName: parts.at(-1) ?? normalized,
    directory: parts.slice(0, -1).join("/")
  };
}

export function splitPathSegments(path: string): string[] {
  return path.trim().split(/[\\/]/).filter(Boolean);
}

export function normalizeChangeType(
  value: string | null
): AgentTurnSummaryChangeType | null {
  switch ((value ?? "").trim().toLowerCase()) {
    case "add":
    case "added":
    case "create":
    case "created":
    case "new":
      return "created";
    case "modify":
    case "modified":
    case "update":
    case "updated":
      return "modified";
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return "deleted";
    default:
      return null;
  }
}

export function inferChangeTypeFromToolContent(
  toolName: string | null,
  content: string | null,
  oldString: string | null,
  newString: string | null
): "modified" | "created" | null {
  const normalizedToolName = normalizeToolName(toolName);
  if (normalizedToolName === "write" || normalizedToolName === "writefile") {
    return content !== null || newString !== null ? "created" : null;
  }
  if (oldString !== null || newString !== null) {
    return "modified";
  }
  return null;
}

export function normalizeToolName(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[_\s-]+/g, "")
    .trim()
    .toLowerCase();
}

export function isFailedToolStatus(value: string | null): boolean {
  switch (normalizeToolName(value)) {
    case "failed":
    case "failure":
    case "error":
    case "errored":
      return true;
    default:
      return false;
  }
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function firstFileChangeValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (fileChangeEntriesFromChanges(value).length > 0) {
      return value;
    }
  }
  return null;
}

export function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function nestedTaskStepsFromPayload(
  payload: Record<string, unknown> | null,
  output: Record<string, unknown> | null
): unknown[] {
  const metadata = objectValue(payload?.metadata);
  return (
    arrayValue(metadata?.steps) ??
    arrayValue(output?.steps) ??
    arrayValue(payload?.steps) ??
    []
  );
}

export function nestedTaskStepStatusKind(
  step: Record<string, unknown>,
  fallback: string | null
): string | null {
  return (
    firstNonEmptyString(
      stringValue(step.statusKind),
      stringValue(step.status),
      stringValue(step.toolStatus)
    ) ??
    fallback ??
    null
  );
}

export function firstLocationPath(value: unknown[] | null): string | null {
  if (!value) {
    return null;
  }
  for (const item of value) {
    const record = objectValue(item);
    const path = stringValue(record?.path);
    if (path) {
      return path;
    }
  }
  return null;
}

export function firstPathValue(value: unknown[] | null): string | null {
  if (!value) {
    return null;
  }
  for (const item of value) {
    const path = stringValue(item);
    if (path) {
      return path;
    }
  }
  return null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function literalStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function firstNonEmptyString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function firstPresentString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}
