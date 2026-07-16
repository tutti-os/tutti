import type { ReactNode } from "react";
import { WorkspaceAppCenterPane } from "@renderer/features/workspace-app-center";

export function StandaloneAgentAppCenterToolPanel({
  workspaceId
}: {
  workspaceId: string;
}): ReactNode {
  return (
    <WorkspaceAppCenterPane
      restoredViewState={null}
      workspaceId={workspaceId}
    />
  );
}
