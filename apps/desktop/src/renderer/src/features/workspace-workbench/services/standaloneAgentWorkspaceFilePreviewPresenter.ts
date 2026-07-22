import type { DesktopHostFilesApi } from "@preload/types";
import type { WorkspaceFilePreviewSurfacePresenter } from "@renderer/features/workspace-file-preview";

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
