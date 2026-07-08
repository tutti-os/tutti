const workspaceFilePreviewSaveRequestEvent =
  "tutti:workspace-file-preview-save-request";

export interface WorkspaceFilePreviewSaveRequestDetail {
  nodeId: string;
}

export interface WorkspaceFilePreviewSaveRequestSource {
  subscribe(nodeId: string, listener: () => void): () => void;
}

export function createWorkspaceFilePreviewWindowSaveRequestSource(
  target?: Pick<Window, "addEventListener" | "removeEventListener">
): WorkspaceFilePreviewSaveRequestSource {
  return {
    subscribe(nodeId, listener) {
      if (!target) {
        return () => undefined;
      }
      const onSaveRequest = (event: Event): void => {
        const detail = (
          event as CustomEvent<WorkspaceFilePreviewSaveRequestDetail>
        ).detail;
        if (detail?.nodeId === nodeId) {
          listener();
        }
      };
      target.addEventListener(
        workspaceFilePreviewSaveRequestEvent,
        onSaveRequest
      );
      return () => {
        target.removeEventListener(
          workspaceFilePreviewSaveRequestEvent,
          onSaveRequest
        );
      };
    }
  };
}

export function requestWorkspaceFilePreviewSave(nodeId: string): void {
  window.dispatchEvent(
    new CustomEvent<WorkspaceFilePreviewSaveRequestDetail>(
      workspaceFilePreviewSaveRequestEvent,
      { detail: { nodeId } }
    )
  );
}
