const workspaceFilePreviewViewModeRequestEvent =
  "tutti:workspace-file-preview-view-mode-request";

export type WorkspaceFilePreviewTextViewMode = "edit" | "preview";

export interface WorkspaceFilePreviewViewModeRequestDetail {
  mode: WorkspaceFilePreviewTextViewMode;
  nodeId: string;
}

export interface WorkspaceFilePreviewViewModeRequestSource {
  subscribe(
    nodeId: string,
    listener: (mode: WorkspaceFilePreviewTextViewMode) => void
  ): () => void;
}

export function createWorkspaceFilePreviewWindowViewModeRequestSource(
  target?: Pick<Window, "addEventListener" | "removeEventListener">
): WorkspaceFilePreviewViewModeRequestSource {
  return {
    subscribe(nodeId, listener) {
      if (!target) {
        return () => undefined;
      }
      const onViewModeRequest = (event: Event): void => {
        const detail = (
          event as CustomEvent<WorkspaceFilePreviewViewModeRequestDetail>
        ).detail;
        if (
          detail?.nodeId === nodeId &&
          (detail.mode === "edit" || detail.mode === "preview")
        ) {
          listener(detail.mode);
        }
      };
      target.addEventListener(
        workspaceFilePreviewViewModeRequestEvent,
        onViewModeRequest
      );
      return () => {
        target.removeEventListener(
          workspaceFilePreviewViewModeRequestEvent,
          onViewModeRequest
        );
      };
    }
  };
}

export function requestWorkspaceFilePreviewViewMode(
  nodeId: string,
  mode: WorkspaceFilePreviewTextViewMode,
  target: Pick<Window, "dispatchEvent"> = window
): void {
  target.dispatchEvent(
    new CustomEvent<WorkspaceFilePreviewViewModeRequestDetail>(
      workspaceFilePreviewViewModeRequestEvent,
      { detail: { mode, nodeId } }
    )
  );
}
