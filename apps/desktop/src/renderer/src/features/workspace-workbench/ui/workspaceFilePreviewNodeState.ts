import type { WorkspaceFilePreviewActivationTarget } from "@tutti-os/workspace-file-preview";
import type { WorkbenchHostNodeData } from "@tutti-os/workbench-surface";
import { isWorkspaceFilePreviewActivationTarget } from "../services/workspaceFilePreviewLaunch";

export type WorkspaceFilePreviewTextHeaderStatus =
  | "error"
  | "loading"
  | "saved"
  | "saving"
  | "unsaved";

export interface WorkspaceFilePreviewTextHeaderState {
  canSave: boolean;
  dirty: boolean;
  message?: string;
  status: WorkspaceFilePreviewTextHeaderStatus;
}

export interface WorkspaceFilePreviewNodeRuntimeState {
  file: WorkspaceFilePreviewActivationTarget;
  textHeader?: WorkspaceFilePreviewTextHeaderState;
}

export interface WorkspaceFilePreviewNodeSnapshotState {
  file: WorkspaceFilePreviewActivationTarget;
}

export function createWorkspaceFilePreviewNodeRuntimeState(input: {
  file: WorkspaceFilePreviewActivationTarget;
  textHeader?: WorkspaceFilePreviewTextHeaderState;
}): WorkspaceFilePreviewNodeRuntimeState {
  return input.textHeader
    ? { file: input.file, textHeader: input.textHeader }
    : { file: input.file };
}

export function createWorkspaceFilePreviewNodeSnapshotState(input: {
  file: WorkspaceFilePreviewActivationTarget;
}): WorkspaceFilePreviewNodeSnapshotState {
  return { file: input.file };
}

export function resolveWorkspaceFilePreviewNodeFile(
  data: Pick<WorkbenchHostNodeData, "runtimeNodeState" | "snapshotNodeState">
): WorkspaceFilePreviewActivationTarget | null {
  for (const value of [data.runtimeNodeState, data.snapshotNodeState]) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const candidate = value as Partial<WorkspaceFilePreviewNodeSnapshotState>;
    if (isWorkspaceFilePreviewActivationTarget(candidate.file)) {
      return candidate.file;
    }
  }

  return null;
}

export function resolveWorkspaceFilePreviewTextHeaderState(
  data: Pick<WorkbenchHostNodeData, "runtimeNodeState">
): WorkspaceFilePreviewTextHeaderState | null {
  if (!data.runtimeNodeState || typeof data.runtimeNodeState !== "object") {
    return null;
  }

  const candidate =
    data.runtimeNodeState as Partial<WorkspaceFilePreviewNodeRuntimeState>;
  if (!isWorkspaceFilePreviewActivationTarget(candidate.file)) {
    return null;
  }

  const textHeader = candidate.textHeader;
  if (!textHeader || typeof textHeader !== "object") {
    return null;
  }

  if (
    textHeader.status !== "error" &&
    textHeader.status !== "loading" &&
    textHeader.status !== "saved" &&
    textHeader.status !== "saving" &&
    textHeader.status !== "unsaved"
  ) {
    return null;
  }

  return {
    canSave: textHeader.canSave === true,
    dirty: textHeader.dirty === true,
    ...(typeof textHeader.message === "string"
      ? { message: textHeader.message }
      : {}),
    status: textHeader.status
  };
}

export function workspaceFilePreviewNodeFileKey(
  file: WorkspaceFilePreviewActivationTarget
): string {
  return [
    file.fileKind,
    file.path,
    file.name,
    file.sizeBytes ?? "",
    file.mtimeMs ?? ""
  ].join("\0");
}
