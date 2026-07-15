import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type { WorkspaceFilePreviewSurfacePresenter } from "../../workspace-file-manager/services/workspaceFilePreviewSurfaceHost.interface.ts";
import { createWorkspaceFilePreviewLaunchRequest } from "./workspaceFilePreviewLaunch.ts";

export function createWorkbenchWorkspaceFilePreviewPresenter(input: {
  host: WorkbenchHostHandle;
}): WorkspaceFilePreviewSurfacePresenter {
  return {
    async present(target) {
      return (
        (await input.host.launchNode(
          createWorkspaceFilePreviewLaunchRequest(target)
        )) !== null
      );
    },
    unsupportedFallbackNotification: "show"
  };
}
