import {
  classifyWorkspaceFilePreviewKind as classifySharedWorkspaceFilePreviewKind,
  resolveWorkspaceFileActivationTarget as resolveSharedWorkspaceFileActivationTarget,
  resolveWorkspaceFilePreviewReadiness as resolveSharedWorkspaceFilePreviewReadiness
} from "@tutti-os/workspace-file-preview";
import type {
  WorkspaceFilePreviewLoadedState,
  WorkspaceFilePreviewReadonlyReason
} from "@tutti-os/workspace-file-preview";
import type {
  WorkspaceFileActivationTarget,
  WorkspaceFileEntry,
  WorkspaceFilePreviewKind
} from "../../workspaceFileManagerTypes.ts";

export {
  decodeWorkspaceTextFile,
  formatWorkspacePreviewByteLimit,
  isWorkspaceFileBrowserOpenable,
  isWorkspacePreviewFileTooLarge,
  isWorkspaceTextFileTooLarge,
  looksLikeBinaryText,
  resolveWorkspaceFileExtension,
  resolveWorkspaceFileVisualKind,
  resolveWorkspaceImageMimeType,
  resolveWorkspaceVideoMimeType,
  workspaceFilePreviewMaxBytes,
  workspaceFileTextMaxBytes
} from "@tutti-os/workspace-file-preview";
export type { WorkspaceFileVisualKind } from "@tutti-os/workspace-file-preview";

export function classifyWorkspaceFilePreviewKind(
  entry: WorkspaceFileEntry
): WorkspaceFilePreviewKind | null {
  return classifySharedWorkspaceFilePreviewKind(entry);
}

export function resolveWorkspaceFileActivationTarget(
  entry: WorkspaceFileEntry
): WorkspaceFileActivationTarget | null {
  const target = resolveSharedWorkspaceFileActivationTarget(entry);
  if (!target) {
    return null;
  }

  return {
    fileKind: target.fileKind,
    mtimeMs: target.mtimeMs ?? null,
    name: target.name,
    path: target.path,
    sizeBytes: target.sizeBytes ?? null
  };
}

export type WorkspaceFilePreviewReadiness =
  | { entry: WorkspaceFileEntry; status: "directory" }
  | {
      entry: WorkspaceFileEntry;
      maxSizeBytes: number;
      reason: Extract<
        WorkspaceFilePreviewReadonlyReason,
        "file_too_large" | "text_too_large"
      >;
      status: "readonly";
    }
  | { entry: WorkspaceFileEntry; status: "unsupported" }
  | {
      entry: WorkspaceFileEntry;
      status: "ready";
      target: WorkspaceFileActivationTarget;
    };

export function resolveWorkspaceFilePreviewReadiness(
  entry: WorkspaceFileEntry
): WorkspaceFilePreviewReadiness {
  const readiness = resolveSharedWorkspaceFilePreviewReadiness(entry);
  if (readiness.status !== "ready") {
    return readiness;
  }

  return {
    entry,
    status: "ready",
    target: {
      fileKind: readiness.target.fileKind,
      mtimeMs: readiness.target.mtimeMs ?? null,
      name: readiness.target.name,
      path: readiness.target.path,
      sizeBytes: readiness.target.sizeBytes ?? null
    }
  };
}

export type WorkspaceFilePreviewLoadedResult = WorkspaceFilePreviewLoadedState<
  WorkspaceFileEntry,
  WorkspaceFileActivationTarget
>;
