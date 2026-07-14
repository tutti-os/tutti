import { WorkspaceFileManagerPane } from "@renderer/features/workspace-file-manager";
import type { WorkspaceWorkbenchBodyRendererContext } from "../services/workspaceWorkbenchHostService.interface";
import { toWorkspaceFilesRevealIntent } from "../services/workspaceFilesRevealIntent";

export function renderWorkspaceFilesNodeBody({
  activation,
  externalNodeState,
  workspaceId
}: WorkspaceWorkbenchBodyRendererContext) {
  return (
    <WorkspaceFilesNodeBody
      activation={activation}
      externalNodeState={externalNodeState}
      workspaceId={workspaceId}
    />
  );
}

function WorkspaceFilesNodeBody({
  activation,
  externalNodeState,
  workspaceId
}: WorkspaceWorkbenchBodyRendererContext) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceFileManagerPane
        className="min-h-0 flex-1 text-[13px]"
        restoredState={externalNodeState}
        revealIntent={toWorkspaceFilesRevealIntent(activation)}
        showPreviewPanel
        workspaceID={workspaceId}
      />
    </div>
  );
}
