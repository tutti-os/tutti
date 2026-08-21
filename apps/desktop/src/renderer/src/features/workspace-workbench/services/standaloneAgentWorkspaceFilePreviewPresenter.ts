import type { WorkspaceFilePreviewSurfacePresenter } from "@renderer/features/workspace-file-preview";

export function createStandaloneAgentWorkspaceFilePreviewPresenter(input: {
  openFile(path: string): Promise<boolean> | boolean;
}): WorkspaceFilePreviewSurfacePresenter {
  return {
    async present(target) {
      return input.openFile(target.path);
    },
    unsupportedFallbackNotification: "suppress"
  };
}
