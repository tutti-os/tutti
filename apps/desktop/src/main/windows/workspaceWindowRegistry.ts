export type RegisteredWorkspaceWindowKind = "agent" | "workspace";

export interface RegisteredWorkspaceWindow {
  isDestroyed(): boolean;
}

interface WorkspaceWindowRegistration {
  kind: RegisteredWorkspaceWindowKind;
  workspaceID: string;
}

export class WorkspaceWindowRegistry<
  TWindow extends RegisteredWorkspaceWindow
> {
  private readonly registrations = new Map<
    TWindow,
    WorkspaceWindowRegistration
  >();

  assertDurableWorkspaceAvailable(workspaceID: string): void {
    if (this.findWorkspaceWindow(workspaceID, "workspace")) {
      throw new Error(
        `Workspace ${workspaceID} already has a durable workspace window.`
      );
    }
  }

  findWorkspaceWindow(
    workspaceID: string,
    kind: RegisteredWorkspaceWindowKind
  ): TWindow | null {
    for (const [window, registration] of this.registrations) {
      if (window.isDestroyed()) {
        this.registrations.delete(window);
        continue;
      }
      if (
        registration.kind === kind &&
        registration.workspaceID === workspaceID
      ) {
        return window;
      }
    }
    return null;
  }

  getKind(window: TWindow): RegisteredWorkspaceWindowKind | null {
    return this.registrations.get(window)?.kind ?? null;
  }

  register(window: TWindow, registration: WorkspaceWindowRegistration): void {
    if (registration.kind === "workspace") {
      this.assertDurableWorkspaceAvailable(registration.workspaceID);
    }
    this.registrations.set(window, registration);
  }

  unregister(window: TWindow): void {
    this.registrations.delete(window);
  }
}
