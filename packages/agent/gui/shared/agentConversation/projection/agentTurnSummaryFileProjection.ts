import { resolveWorkspaceFilePathCandidate } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentTurnSummaryFileVM } from "../contracts/agentTurnSummaryRowVM";

export type AgentTurnSummaryChangeType = AgentTurnSummaryFileVM["changeType"];
export interface AgentTurnSummaryProjectionOptions {
  defaultCwd?: string | null;
  workspaceRoot?: string | null;
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
    workspaceRoot: options.workspaceRoot,
    basePath: options.defaultCwd
  })
    ? path
    : null;
}

function isIgnoredFilePath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath === "/dev/null" || normalizedPath === "NUL";
}

function isStructuredPayloadPath(path: string): boolean {
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

function shortestUniquePathSuffixByPath(paths: string[]): Map<string, string> {
  const partsByPath = new Map(
    paths.map((path) => [path, splitPathSegments(path)])
  );
  const labels = new Map<string, string>();
  const unresolved = new Set(paths);
  for (let depth = 1; unresolved.size > 0; depth += 1) {
    const grouped = new Map<string, string[]>();
    for (const path of unresolved) {
      const parts = partsByPath.get(path) ?? [];
      const label =
        parts.slice(-Math.min(depth, parts.length)).join("/") ||
        parts.at(-1) ||
        path;
      grouped.set(label, [...(grouped.get(label) ?? []), path]);
    }
    let resolvedCount = 0;
    for (const [label, group] of grouped) {
      if (group.length !== 1 || !group[0]) {
        continue;
      }
      labels.set(group[0], label);
      unresolved.delete(group[0]);
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

function splitPathSegments(path: string): string[] {
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
    case "edit":
    case "edited":
    case "change":
    case "changed":
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

export function isFailedToolStatus(value: string | null): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return ["failed", "error", "errored", "canceled", "cancelled"].includes(
    normalized
  );
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function firstFileChangeValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (Array.isArray(value) || objectValue(value)) {
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
  const candidates = [
    arrayValue(payload?.steps),
    arrayValue(output?.steps),
    arrayValue(objectValue(payload?.metadata)?.steps),
    arrayValue(objectValue(output?.metadata)?.steps)
  ];
  return candidates.find((value) => value && value.length > 0) ?? [];
}

export function nestedTaskStepStatusKind(
  step: Record<string, unknown>,
  fallback: string | null
): string | null {
  return (
    stringValue(step.statusKind) ?? stringValue(step.status) ?? fallback ?? null
  );
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function literalStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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
