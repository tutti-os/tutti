interface WorkspaceScopedRegistration<TValue> {
  value: TValue;
}

export class WorkspaceScopedRegistrationRegistry<TValue> {
  private readonly registrations = new Map<
    string,
    WorkspaceScopedRegistration<TValue>
  >();

  get(workspaceId: string): TValue | undefined {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    if (!normalizedWorkspaceId) {
      return undefined;
    }
    return this.registrations.get(normalizedWorkspaceId)?.value;
  }

  register(workspaceId: string, value: TValue): () => void {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    if (!normalizedWorkspaceId) {
      return noop;
    }

    const registration = { value };
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
