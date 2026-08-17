import type { WorkspaceUserProjectApi } from "@tutti-os/workspace-user-project/contracts";

export function createAgentGUIUserProjectSelectionApi({
  importDirectory,
  selectProjectDirectory,
  userProjects
}: {
  importDirectory?: WorkspaceUserProjectApi["importDirectory"];
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  userProjects: WorkspaceUserProjectApi | null | undefined;
}): WorkspaceUserProjectApi | null {
  if (!userProjects) {
    return null;
  }
  if (!selectProjectDirectory && !importDirectory) {
    return userProjects;
  }
  return {
    ...userProjects,
    ...(importDirectory ? { importDirectory } : {}),
    ...(selectProjectDirectory
      ? { selectDirectory: selectProjectDirectory }
      : {})
  };
}
