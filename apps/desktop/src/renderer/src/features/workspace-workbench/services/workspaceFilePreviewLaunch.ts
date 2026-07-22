import type { WorkspaceFilePreviewActivationTarget } from "@tutti-os/workspace-file-preview";
import type { WorkbenchHostLaunchInput } from "@tutti-os/workbench-surface";

export const workspaceImageFileNodeTypeID = "workspace-image-file";
export const workspaceTextFileNodeTypeID = "workspace-text-file";
export const workspaceFilePreviewActivationType = "workspace-file-preview";

export function createWorkspaceFilePreviewLaunchRequest(
  target: WorkspaceFilePreviewActivationTarget
): WorkbenchHostLaunchInput {
  return {
    launchSource: "file_manager",
    payload: target,
    reason: "host",
    typeId: resolveWorkspaceFilePreviewNodeTypeID(target.fileKind)
  };
}

export function createWorkspaceFilePreviewInstanceID(
  target: WorkspaceFilePreviewActivationTarget
): string {
  return `path:${hashWorkspaceFilePreviewPath(target.path)}`;
}

export function resolveWorkspaceFilePreviewNodeTypeID(
  fileKind: WorkspaceFilePreviewActivationTarget["fileKind"]
): string {
  return fileKind === "image"
    ? workspaceImageFileNodeTypeID
    : workspaceTextFileNodeTypeID;
}

export function isWorkspaceFilePreviewNodeTypeID(typeID: string): boolean {
  return (
    typeID === workspaceImageFileNodeTypeID ||
    typeID === workspaceTextFileNodeTypeID
  );
}

export function isWorkspaceFilePreviewActivationTarget(
  value: unknown
): value is WorkspaceFilePreviewActivationTarget {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WorkspaceFilePreviewActivationTarget>;
  return (
    (candidate.fileKind === "image" ||
      candidate.fileKind === "text" ||
      candidate.fileKind === "video") &&
    typeof candidate.name === "string" &&
    candidate.name.trim().length > 0 &&
    typeof candidate.path === "string" &&
    candidate.path.trim().length > 0 &&
    (candidate.mtimeMs === undefined ||
      candidate.mtimeMs === null ||
      typeof candidate.mtimeMs === "number") &&
    (candidate.sizeBytes === undefined ||
      candidate.sizeBytes === null ||
      typeof candidate.sizeBytes === "number")
  );
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
