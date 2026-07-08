import type { ReactNode } from "react";
import { defaultIssueManagerNodeFrame } from "@tutti-os/workspace-issue-manager/workbench/constants";
import type {
  WorkbenchFrame,
  WorkbenchHostActivation,
  WorkbenchHostDockEntry
} from "@tutti-os/workbench-surface";
import type { WorkspaceFilesNodeActivationPayload } from "../workspaceWorkbenchHostService.interface";
import { workspaceFilesLaunchTypeId } from "../workspaceFilesLaunchCoordinator.ts";
export {
  createWorkspaceAgentGuiDraftLaunchRequest,
  createWorkspaceAgentGuiLaunchDescriptor,
  createWorkspaceAgentGuiInstanceId,
  createWorkspaceAgentGuiUnifiedDraftLaunchRequest,
  createWorkspaceAgentGuiUnifiedSessionLaunchRequest,
  workspaceAgentGuiDockEntryId,
  workspaceAgentGuiInstanceId,
  workspaceAgentGuiNodeID,
  workspaceAgentGuiProviderFromIdentifier,
  workspaceAgentGuiProviderFromLaunchRequest,
  type WorkspaceAgentGuiProvider
} from "../workspaceAgentGuiLaunch.ts";

export const workspaceFilesNodeID = workspaceFilesLaunchTypeId;
export const workspaceBrowserNodeID = "browser";
export const workspaceFilesNodeFrame: WorkbenchFrame = {
  x: 160,
  y: 110,
  width: 1040,
  height: defaultIssueManagerNodeFrame.height
};
export const workspaceAgentGuiNodeFrame: WorkbenchFrame = {
  x: 140,
  y: 48,
  width: workspaceFilesNodeFrame.width,
  height: workspaceFilesNodeFrame.height
};
export const workspaceFilePreviewNodeFrame: WorkbenchFrame = {
  height: defaultIssueManagerNodeFrame.height,
  width: 720,
  x: 164,
  y: 104
};

export function toWorkspaceFilesActivation(
  activation: WorkbenchHostActivation<unknown> | null
): WorkbenchHostActivation<WorkspaceFilesNodeActivationPayload> | null {
  return activation &&
    activation.type === "reveal-file" &&
    isWorkspaceFilesActivationPayload(activation.payload)
    ? (activation as WorkbenchHostActivation<WorkspaceFilesNodeActivationPayload>)
    : null;
}

export function createWorkspaceFilesDockEntry(input: {
  filesLabel: string;
  icon: ReactNode;
}): WorkbenchHostDockEntry {
  return {
    icon: input.icon,
    id: workspaceFilesNodeID,
    label: input.filesLabel,
    launchBehavior: "enabled",
    matchNode: (node) => node.data.typeId === workspaceFilesNodeID,
    order: 10,
    resolvePopupItem: ({ externalNodeState, node }) => {
      const state =
        (externalNodeState as {
          currentDirectoryPath?: string | null;
        } | null) ?? {};
      const subtitle = state.currentDirectoryPath ?? node.data.instanceId;
      return {
        revision: `${node.title}\n${subtitle}`,
        subtitle,
        title: node.title
      };
    },
    sectionId: "apps",
    typeId: workspaceFilesNodeID,
    visibility: "always"
  };
}

function isWorkspaceFilesActivationPayload(
  payload: unknown
): payload is WorkspaceFilesNodeActivationPayload {
  return (
    Boolean(payload) &&
    typeof payload === "object" &&
    typeof (payload as Partial<WorkspaceFilesNodeActivationPayload>).path ===
      "string"
  );
}
