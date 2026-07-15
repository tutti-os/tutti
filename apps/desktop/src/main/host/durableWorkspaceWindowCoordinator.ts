export interface DurableWorkspaceWindowCoordinator<TWindow> {
  show(workspaceID: string): Promise<TWindow>;
}

export function createDurableWorkspaceWindowCoordinator<TWindow>(input: {
  activate(window: TWindow): void;
  find(workspaceID: string): TWindow | null;
  open(workspaceID: string): Promise<TWindow>;
}): DurableWorkspaceWindowCoordinator<TWindow> {
  const pendingWindows = new Map<string, Promise<TWindow>>();

  return {
    async show(workspaceID) {
      const pendingWindow = pendingWindows.get(workspaceID);
      if (pendingWindow) {
        return await pendingWindow;
      }
      const existingWindow = input.find(workspaceID);
      if (existingWindow) {
        input.activate(existingWindow);
        return existingWindow;
      }
      const openWindow = input.open(workspaceID);
      pendingWindows.set(workspaceID, openWindow);
      try {
        return await openWindow;
      } finally {
        if (pendingWindows.get(workspaceID) === openWindow) {
          pendingWindows.delete(workspaceID);
        }
      }
    }
  };
}
