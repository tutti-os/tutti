import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";
import type { WorkspaceFilesNodeActivationPayload } from "./workspaceWorkbenchHostService.interface";

export interface WorkspaceFilesRevealIntent {
  mode?: "select" | "open";
  path: string;
  requestID: string;
}

export function toWorkspaceFilesRevealIntent(
  activation: WorkbenchHostActivation<WorkspaceFilesNodeActivationPayload> | null
): WorkspaceFilesRevealIntent | null {
  if (!activation?.payload) {
    return null;
  }

  return {
    ...(activation.payload.mode ? { mode: activation.payload.mode } : {}),
    path: activation.payload.path,
    requestID: String(activation.sequence)
  };
}
