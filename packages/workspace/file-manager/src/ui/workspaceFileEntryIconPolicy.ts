import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import {
  classifyWorkspaceFilePreviewKind,
  resolveWorkspaceFileVisualKind
} from "../services/workspaceFileManagerModel.ts";

export function shouldResolveWorkspaceFileEntryIcon(
  entry: WorkspaceFileEntry
): boolean {
  if (isWorkspaceApplicationBundle(entry)) {
    return true;
  }
  if (shouldUseWorkspaceFileExtensionDocumentIcon(entry)) {
    return false;
  }
  return entry.kind === "file";
}

export function shouldUseWorkspaceFileExtensionDocumentIcon(
  entry: WorkspaceFileEntry
): boolean {
  if (entry.kind !== "file") {
    return false;
  }

  const visualKind = resolveWorkspaceFileVisualKind(entry);
  return (
    visualKind === "code" ||
    visualKind === "markdown" ||
    classifyWorkspaceFilePreviewKind(entry) === "text"
  );
}

export function isWorkspaceApplicationBundle(
  entry: Pick<WorkspaceFileEntry, "name">
): boolean {
  return entry.name.trim().toLowerCase().endsWith(".app");
}

export function resolveWorkspaceFileEntryIconCacheKey(
  entry: WorkspaceFileEntry
): string {
  return `${entry.path}:${entry.mtimeMs ?? 0}`;
}
