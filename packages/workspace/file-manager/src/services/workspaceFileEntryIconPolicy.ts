import {
  classifyWorkspaceFilePreviewKind,
  resolveWorkspaceFileExtension,
  resolveWorkspaceFileVisualKind
} from "@tutti-os/workspace-file-preview";
import type { WorkspaceFileEntry } from "./workspaceFileManagerTypes.ts";

const defaultApplicationIconExtensions = new Set([
  "ai",
  "dmg",
  "doc",
  "docx",
  "eps",
  "fig",
  "indd",
  "key",
  "numbers",
  "odp",
  "ods",
  "odt",
  "pages",
  "pkg",
  "ppt",
  "pptx",
  "psd",
  "rtf",
  "sketch",
  "xd",
  "xls",
  "xlsx"
]);

const archiveIconExtensions = new Set([
  "7z",
  "gz",
  "rar",
  "tar",
  "tgz",
  "xz",
  "zip"
]);

const extensionDocumentIconExtensions = new Set(["pdf"]);

export interface WorkspaceFileEntryIconPolicyOptions {
  includeImageThumbnails?: boolean;
}

export function shouldResolveWorkspaceFileEntryIcon(
  entry: WorkspaceFileEntry,
  options: WorkspaceFileEntryIconPolicyOptions = {}
): boolean {
  return (
    (options.includeImageThumbnails &&
      shouldResolveWorkspaceFileImageThumbnail(entry)) ||
    isWorkspaceApplicationBundle(entry) ||
    resolveWorkspaceFileDefaultApplicationIconExtension(entry) !== null
  );
}

export function shouldUseWorkspaceFileExtensionDocumentIcon(
  entry: WorkspaceFileEntry
): boolean {
  if (entry.kind !== "file") {
    return false;
  }

  const visualKind = resolveWorkspaceFileVisualKind(entry);
  const extension = resolveWorkspaceFileExtension(entry.name).toLowerCase();
  return (
    visualKind === "code" ||
    visualKind === "markdown" ||
    extensionDocumentIconExtensions.has(extension) ||
    classifyWorkspaceFilePreviewKind(entry) === "text"
  );
}

export function shouldUseWorkspaceFileArchiveIcon(
  entry: WorkspaceFileEntry
): boolean {
  return (
    entry.kind === "file" &&
    archiveIconExtensions.has(
      resolveWorkspaceFileExtension(entry.name).toLowerCase()
    )
  );
}

export function isWorkspaceApplicationBundle(entry: {
  kind: string;
  name: string;
}): boolean {
  return (
    entry.kind !== "file" && entry.name.trim().toLowerCase().endsWith(".app")
  );
}

export function resolveWorkspaceFileDefaultApplicationIconExtension(entry: {
  kind: string;
  name: string;
}): string | null {
  if (entry.kind !== "file") {
    return null;
  }

  const extension = resolveWorkspaceFileExtension(entry.name).toLowerCase();
  return defaultApplicationIconExtensions.has(extension) ? extension : null;
}

export function resolveWorkspaceFileEntryIconCacheKey(
  entry: WorkspaceFileEntry
): string {
  if (shouldResolveWorkspaceFileImageThumbnail(entry)) {
    return `image-thumbnail:${entry.path}:${entry.mtimeMs ?? 0}`;
  }

  if (isWorkspaceApplicationBundle(entry)) {
    return `application:${entry.path}:${entry.mtimeMs ?? 0}`;
  }

  const fileTypeExtension =
    resolveWorkspaceFileDefaultApplicationIconExtension(entry);
  if (fileTypeExtension) {
    return `file-type-default-application:${fileTypeExtension}`;
  }

  return `default:${entry.path}:${entry.mtimeMs ?? 0}`;
}

function shouldResolveWorkspaceFileImageThumbnail(
  entry: WorkspaceFileEntry
): boolean {
  return (
    entry.kind === "file" && resolveWorkspaceFileVisualKind(entry) === "image"
  );
}
