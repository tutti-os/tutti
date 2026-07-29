import type {
  IWorkspaceFilePreviewSurfaceHost,
  WorkspaceFilePreviewPresentationResult,
  WorkspaceFilePreviewSurfacePresenter
} from "../workspaceFilePreviewSurfaceHost.interface.ts";

interface WorkspaceFilePreviewSurfaceRegistration {
  presenter: WorkspaceFilePreviewSurfacePresenter;
}

export class WorkspaceFilePreviewSurfaceHost implements IWorkspaceFilePreviewSurfaceHost {
  readonly _serviceBrand = undefined;

  private readonly registrations = new Map<
    string,
    WorkspaceFilePreviewSurfaceRegistration
  >();

  getUnsupportedFallbackNotification(
    workspaceID: string
  ): WorkspaceFilePreviewPresentationResult["unsupportedFallbackNotification"] {
    return (
      this.registrations.get(workspaceID)?.presenter
        .unsupportedFallbackNotification ?? "show"
    );
  }

  async present(
    workspaceID: string,
    target: Parameters<WorkspaceFilePreviewSurfacePresenter["present"]>[0]
  ): Promise<WorkspaceFilePreviewPresentationResult> {
    const registration = this.registrations.get(workspaceID);
    if (!registration) {
      return {
        presented: false,
        unsupportedFallbackNotification: "show"
      };
    }
    return {
      presented: (await registration.presenter.present(target)) === true,
      unsupportedFallbackNotification:
        registration.presenter.unsupportedFallbackNotification
    };
  }

  registerPresenter(
    workspaceID: string,
    presenter: WorkspaceFilePreviewSurfacePresenter
  ): () => void {
    const registration = { presenter };
    this.registrations.set(workspaceID, registration);
    return () => {
      if (this.registrations.get(workspaceID) === registration) {
        this.registrations.delete(workspaceID);
      }
    };
  }
}
