interface WorkspaceScopedPresenterRegistration<TPresenter> {
  presenter: TPresenter;
}

export class WorkspaceScopedPresenterRegistry<TPresenter> {
  private readonly registrations = new Map<
    string,
    WorkspaceScopedPresenterRegistration<TPresenter>
  >();

  get(workspaceId: string): TPresenter | undefined {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    if (!normalizedWorkspaceId) {
      return undefined;
    }
    return this.registrations.get(normalizedWorkspaceId)?.presenter;
  }

  register(workspaceId: string, presenter: TPresenter): () => void {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    if (!normalizedWorkspaceId) {
      return noop;
    }

    const registration = { presenter };
    this.registrations.set(normalizedWorkspaceId, registration);
    return () => {
      if (this.registrations.get(normalizedWorkspaceId) === registration) {
        this.registrations.delete(normalizedWorkspaceId);
      }
    };
  }
}

function normalizeWorkspaceId(workspaceId: string): string {
  return workspaceId.trim();
}

function noop(): void {}
