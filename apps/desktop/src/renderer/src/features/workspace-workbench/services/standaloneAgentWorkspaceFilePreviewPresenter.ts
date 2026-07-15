import type { DesktopHostFilesApi } from "@preload/types";
import type { WorkspaceFilePreviewSurfacePresenter } from "../../workspace-file-manager/services/workspaceFilePreviewSurfaceHost.interface.ts";

export function createStandaloneAgentWorkspaceFilePreviewPresenter(input: {
  hostFilesApi: Pick<DesktopHostFilesApi, "openFile">;
  workspaceId: string;
}): WorkspaceFilePreviewSurfacePresenter {
  return {
    async present(target) {
      await input.hostFilesApi.openFile(input.workspaceId, target.path);
      return true;
    },
    unsupportedFallbackNotification: "suppress"
  };
}
