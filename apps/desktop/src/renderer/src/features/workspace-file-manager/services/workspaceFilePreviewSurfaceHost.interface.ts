import { createDecorator } from "@tutti-os/infra/di";
import type { WorkspaceFileActivationTarget } from "@tutti-os/workspace-file-manager/services";

export interface WorkspaceFilePreviewSurfacePresenter {
  readonly unsupportedFallbackNotification: "show" | "suppress";
  present(target: WorkspaceFileActivationTarget): Promise<boolean> | boolean;
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
    target: WorkspaceFileActivationTarget
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
