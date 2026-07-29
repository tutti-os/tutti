/**
 * Open / open-with / browser-activation advisories.
 *
 * These helpers live on the file-manager host edge, not in
 * `@tutti-os/workspace-file-preview` (see that package CONTRACT.md).
 */

import {
  classifyWorkspaceFilePreviewKind,
  isTextDegradablePreviewKind,
  isWorkspaceFileBrowserHtmlExtension,
  isWorkspaceFileImageExtension,
  resolveWorkspaceFileExtension,
  resolveWorkspaceFileVisualKind,
  workspaceFileBrowserVideoExtensions
} from "@tutti-os/workspace-file-preview";

export interface WorkspaceFileOpenWithEntry {
  kind: string;
  name?: string;
  path: string;
}

/**
 * Extensions where macOS Launch Services may register video handlers even when
 * the workspace file is source code (UTI / uniform type collisions).
 */
export const workspaceFileVideoHandlerCollisionExtensions = new Set(["ts"]);

export function isWorkspaceFileBrowserOpenable(
  entry: WorkspaceFileOpenWithEntry
): boolean {
  if (entry.kind !== "file") {
    return false;
  }

  const extension = resolveWorkspaceFileExtension(
    entry.path || entry.name || ""
  );
  if (
    extension === "pdf" ||
    isWorkspaceFileBrowserHtmlExtension(extension) ||
    isWorkspaceFileImageExtension(extension) ||
    workspaceFileBrowserVideoExtensions.has(extension)
  ) {
    return true;
  }

  return isTextDegradablePreviewKind(classifyWorkspaceFilePreviewKind(entry));
}

export function shouldFilterVideoPlayersForOpenWith(
  entry: WorkspaceFileOpenWithEntry
): boolean {
  if (entry.kind !== "file") {
    return false;
  }

  const visualKind = resolveWorkspaceFileVisualKind(entry);
  if (visualKind === "video") {
    return false;
  }

  const extension = resolveWorkspaceFileExtension(
    entry.path || entry.name || ""
  );
  if (workspaceFileVideoHandlerCollisionExtensions.has(extension)) {
    return true;
  }

  if (visualKind === "code" || visualKind === "markdown") {
    return true;
  }

  return isTextDegradablePreviewKind(classifyWorkspaceFilePreviewKind(entry));
}
