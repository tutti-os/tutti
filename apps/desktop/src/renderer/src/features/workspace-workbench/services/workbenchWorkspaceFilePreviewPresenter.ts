import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type { WorkspaceFilePreviewSurfacePresenter } from "@renderer/features/workspace-file-preview";
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
