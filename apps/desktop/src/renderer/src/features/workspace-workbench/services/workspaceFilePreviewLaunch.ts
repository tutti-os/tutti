import {
  resolveWorkspaceFileBuiltinRenderKind,
  type WorkspaceFilePreviewKind,
  type WorkspaceFilePreviewTarget
} from "@tutti-os/workspace-file-preview";
import type { WorkbenchHostLaunchInput } from "@tutti-os/workbench-surface";

export const workspaceImageFileNodeTypeID = "workspace-image-file";
export const workspaceTextFileNodeTypeID = "workspace-text-file";
export const workspaceFilePreviewActivationType = "workspace-file-preview";

export function createWorkspaceFilePreviewLaunchRequest(
  target: WorkspaceFilePreviewTarget
): WorkbenchHostLaunchInput {
  return {
    launchSource: "file_manager",
    payload: target,
    reason: "host",
    typeId: resolveWorkspaceFilePreviewNodeTypeID(target.previewKind)
  };
}

export function createWorkspaceFilePreviewInstanceID(
  target: WorkspaceFilePreviewTarget
): string {
  return `path:${hashWorkspaceFilePreviewPath(target.path)}`;
}

export function resolveWorkspaceFilePreviewNodeTypeID(
  previewKind: WorkspaceFilePreviewKind
): string {
  return resolveWorkspaceFileBuiltinRenderKind(previewKind) === "image"
    ? workspaceImageFileNodeTypeID
    : workspaceTextFileNodeTypeID;
}

export function isWorkspaceFilePreviewNodeTypeID(typeID: string): boolean {
  return (
    typeID === workspaceImageFileNodeTypeID ||
    typeID === workspaceTextFileNodeTypeID
  );
}

/**
 * Coerce unknown activation/snapshot payloads into a canonical preview target.
 * Accepts legacy `fileKind` (`image` | `text` | `video`) from pre-rename
 * snapshots and normalizes it to `previewKind`.
 */
export function coerceWorkspaceFilePreviewTarget(
  value: unknown
): WorkspaceFilePreviewTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<WorkspaceFilePreviewTarget> & {
    fileKind?: unknown;
  };
  const previewKind = resolveCoercedPreviewKind(candidate);
  if (
    previewKind === null ||
    typeof candidate.name !== "string" ||
    candidate.name.trim().length === 0 ||
    typeof candidate.path !== "string" ||
    candidate.path.trim().length === 0 ||
    (candidate.mtimeMs !== undefined &&
      candidate.mtimeMs !== null &&
      typeof candidate.mtimeMs !== "number") ||
    (candidate.sizeBytes !== undefined &&
      candidate.sizeBytes !== null &&
      typeof candidate.sizeBytes !== "number")
  ) {
    return null;
  }

  return {
    previewKind,
    name: candidate.name,
    path: candidate.path,
    ...(candidate.mtimeMs === undefined ? {} : { mtimeMs: candidate.mtimeMs }),
    ...(candidate.sizeBytes === undefined
      ? {}
      : { sizeBytes: candidate.sizeBytes })
  };
}

/**
 * Type guard for canonical preview targets (`previewKind` present).
 * Prefer {@link coerceWorkspaceFilePreviewTarget} when reading unknown
 * activation/snapshot payloads that may still use legacy `fileKind`.
 */
export function isWorkspaceFilePreviewTarget(
  value: unknown
): value is WorkspaceFilePreviewTarget {
  return (
    !!value &&
    typeof value === "object" &&
    "previewKind" in value &&
    coerceWorkspaceFilePreviewTarget(value) !== null
  );
}

function resolveCoercedPreviewKind(
  candidate: Partial<WorkspaceFilePreviewTarget> & { fileKind?: unknown }
): WorkspaceFilePreviewKind | null {
  if (candidate.previewKind !== undefined) {
    return resolveWorkspaceFileBuiltinRenderKind(candidate.previewKind) === null
      ? null
      : candidate.previewKind;
  }

  // Legacy activation / snapshot field before previewKind rename.
  if (
    candidate.fileKind === "image" ||
    candidate.fileKind === "text" ||
    candidate.fileKind === "video"
  ) {
    return candidate.fileKind;
  }

  return null;
}

function hashWorkspaceFilePreviewPath(path: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let index = 0; index < path.length; index += 1) {
    hash ^= BigInt(path.charCodeAt(index));
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, "0");
}
