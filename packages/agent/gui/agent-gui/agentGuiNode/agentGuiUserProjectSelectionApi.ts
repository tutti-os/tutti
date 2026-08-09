import type { WorkspaceUserProjectApi } from "@tutti-os/workspace-user-project/contracts";

export function createAgentGUIUserProjectSelectionApi({
  selectProjectDirectory,
  userProjects
}: {
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  userProjects: WorkspaceUserProjectApi | null | undefined;
}): WorkspaceUserProjectApi | null {
  if (!userProjects) {
    return null;
  }
  if (!selectProjectDirectory) {
    return userProjects;
  }
  return {
    ...userProjects,
    selectDirectory: selectProjectDirectory
  };
}
