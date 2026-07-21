import type { WorkspaceUserProjectApi } from "@tutti-os/workspace-user-project/contracts";
import type { AgentHostUserProjectsApi } from "../../host/agentHostApi";

export function createAgentGUIUserProjectSelectionApi({
  selectProjectDirectory,
  userProjects
}: {
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  userProjects: AgentHostUserProjectsApi | null | undefined;
}): WorkspaceUserProjectApi | null {
  if (!userProjects) {
    return null;
  }
  return {
    ...userProjects,
    selectDirectory: selectProjectDirectory
  };
}
