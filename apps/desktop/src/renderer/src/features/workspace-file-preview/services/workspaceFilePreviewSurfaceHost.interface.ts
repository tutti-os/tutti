import { createDecorator } from "@tutti-os/infra/di";
import type { WorkspaceFilePreviewTarget } from "@tutti-os/workspace-file-preview";

export interface WorkspaceFilePreviewSurfacePresenter {
  readonly unsupportedFallbackNotification: "show" | "suppress";
  present(target: WorkspaceFilePreviewTarget): Promise<boolean> | boolean;
}

export interface WorkspaceFilePreviewPresentationResult {
  readonly presented: boolean;
  readonly unsupportedFallbackNotification: "show" | "suppress";
}

export interface IWorkspaceFilePreviewSurfaceHost {
  readonly _serviceBrand: undefined;
  getUnsupportedFallbackNotification(
    workspaceID: string
  ): WorkspaceFilePreviewPresentationResult["unsupportedFallbackNotification"];
  present(
    workspaceID: string,
    target: WorkspaceFilePreviewTarget
  ): Promise<WorkspaceFilePreviewPresentationResult>;
  registerPresenter(
    workspaceID: string,
    presenter: WorkspaceFilePreviewSurfacePresenter
  ): () => void;
}

export const IWorkspaceFilePreviewSurfaceHost =
  createDecorator<IWorkspaceFilePreviewSurfaceHost>(
    "workspace-file-preview-surface-host"
  );
