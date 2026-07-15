import type { WorkspaceUserProjectApi } from "@tutti-os/workspace-user-project/contracts";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/services/workspaceUserProjectService.interface.ts";

export function createWorkspaceAppExternalUserProjectApi(
  service: IWorkspaceUserProjectService
): WorkspaceUserProjectApi {
  return {
    checkPath: (input) => service.checkProjectPath(input.path),
    create: (input) => service.createProject(input.name),
    getDefaultSelection: () => service.getDefaultSelection(),
    getSnapshot: () =>
      Promise.resolve(cloneWorkspaceUserProjectServiceSnapshot(service)),
    list: async () => {
      await service.ensureLoaded();
      return {
        projects: service.store.projects.map((project) => ({ ...project }))
      };
    },
    prepareSelection: (input) => service.prepareSelection(input),
    refresh: async () => {
      await service.refresh();
      return cloneWorkspaceUserProjectServiceSnapshot(service);
    },
    rememberDefaultSelection: (input) =>
      service.rememberDefaultSelection(input),
    selectDirectory: () => service.selectDirectory(),
    subscribe: (listener) =>
      service.subscribe(() => {
        listener(cloneWorkspaceUserProjectServiceSnapshot(service));
      }),
    use: (input) => service.registerProjectPath(input.path)
  };
}

function cloneWorkspaceUserProjectServiceSnapshot(
  service: IWorkspaceUserProjectService
): ReturnType<IWorkspaceUserProjectService["getSnapshot"]> {
  const snapshot = service.getSnapshot();
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({ ...project }))
  };
}
