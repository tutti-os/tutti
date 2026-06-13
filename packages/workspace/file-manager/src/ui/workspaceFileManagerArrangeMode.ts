import {
  resolveWorkspaceFileExtension,
  resolveWorkspaceFileVisualKind
} from "../services/workspaceFileManagerModel.ts";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";

export type WorkspaceFileManagerArrangeMode =
  | "none"
  | "name"
  | "kind"
  | "application"
  | "lastOpened"
  | "dateAdded"
  | "modified"
  | "created"
  | "size"
  | "tags";

export const workspaceFileManagerArrangeModeStorageKey =
  "tutti.workspace-file-manager.arrange-mode";

const workspaceFileManagerArrangeModes =
  new Set<WorkspaceFileManagerArrangeMode>([
    "none",
    "name",
    "kind",
    "application",
    "lastOpened",
    "dateAdded",
    "modified",
    "created",
    "size",
    "tags"
  ]);

export function readWorkspaceFileManagerArrangeMode(): WorkspaceFileManagerArrangeMode {
  if (typeof window === "undefined") {
    return "none";
  }

  const stored = window.localStorage.getItem(
    workspaceFileManagerArrangeModeStorageKey
  );
  return isWorkspaceFileManagerArrangeMode(stored) ? stored : "none";
}

export function writeWorkspaceFileManagerArrangeMode(
  arrangeMode: WorkspaceFileManagerArrangeMode
): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    workspaceFileManagerArrangeModeStorageKey,
    arrangeMode
  );
}

export function sortWorkspaceFileEntriesForArrangeMode(
  entries: readonly WorkspaceFileEntry[],
  arrangeMode: WorkspaceFileManagerArrangeMode
): readonly WorkspaceFileEntry[] {
  if (arrangeMode === "none") {
    return entries;
  }

  return [...entries].sort((left, right) => {
    switch (arrangeMode) {
      case "name":
        return (
          compareDirectoryFirst(left, right) || compareEntryName(left, right)
        );
      case "kind":
        return (
          compareDirectoryFirst(left, right) ||
          compareText(
            resolveEntryKindGroup(left),
            resolveEntryKindGroup(right)
          ) ||
          compareEntryName(left, right)
        );
      case "application":
        return (
          compareDirectoryFirst(left, right) ||
          compareText(
            resolveEntryApplicationGroup(left),
            resolveEntryApplicationGroup(right)
          ) ||
          compareEntryName(left, right)
        );
      case "lastOpened":
        return (
          compareDateDescending(left, right, "lastOpened") ||
          compareEntryName(left, right)
        );
      case "dateAdded":
        return (
          compareDateDescending(left, right, "dateAdded") ||
          compareEntryName(left, right)
        );
      case "modified":
        return (
          compareDateDescending(left, right, "modified") ||
          compareEntryName(left, right)
        );
      case "created":
        return (
          compareDateDescending(left, right, "created") ||
          compareEntryName(left, right)
        );
      case "size":
        return (
          compareSizeDescending(left, right) || compareEntryName(left, right)
        );
      case "tags":
        return (
          compareDirectoryFirst(left, right) || compareEntryName(left, right)
        );
    }
  });
}

function isWorkspaceFileManagerArrangeMode(
  value: string | null
): value is WorkspaceFileManagerArrangeMode {
  return workspaceFileManagerArrangeModes.has(
    value as WorkspaceFileManagerArrangeMode
  );
}

function compareDirectoryFirst(
  left: WorkspaceFileEntry,
  right: WorkspaceFileEntry
): number {
  const leftRank = left.kind === "directory" ? 0 : 1;
  const rightRank = right.kind === "directory" ? 0 : 1;
  return leftRank - rightRank;
}

function compareEntryName(
  left: WorkspaceFileEntry,
  right: WorkspaceFileEntry
): number {
  return compareText(left.name, right.name);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

export function resolveWorkspaceFileEntryArrangeDateMs(
  entry: WorkspaceFileEntry,
  arrangeMode: WorkspaceFileManagerArrangeMode
): number | null {
  switch (arrangeMode) {
    case "lastOpened":
      return entry.lastOpenedMs ?? entry.mtimeMs;
    case "dateAdded":
    case "created":
      return entry.createdTimeMs ?? entry.mtimeMs;
    case "modified":
    default:
      return entry.mtimeMs;
  }
}

function compareDateDescending(
  left: WorkspaceFileEntry,
  right: WorkspaceFileEntry,
  arrangeMode: WorkspaceFileManagerArrangeMode
): number {
  return (
    (resolveWorkspaceFileEntryArrangeDateMs(right, arrangeMode) ?? 0) -
    (resolveWorkspaceFileEntryArrangeDateMs(left, arrangeMode) ?? 0)
  );
}

function compareSizeDescending(
  left: WorkspaceFileEntry,
  right: WorkspaceFileEntry
): number {
  return (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0);
}

function resolveEntryKindGroup(entry: WorkspaceFileEntry): string {
  if (entry.kind === "directory") {
    return "directory";
  }
  return resolveWorkspaceFileVisualKind(entry);
}

function resolveEntryApplicationGroup(entry: WorkspaceFileEntry): string {
  if (entry.kind === "directory") {
    return "folder";
  }
  if (entry.name.trim().toLowerCase().endsWith(".app")) {
    return "application";
  }
  return (
    resolveWorkspaceFileExtension(entry.name) || resolveEntryKindGroup(entry)
  );
}
