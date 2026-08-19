export interface DurableWorkspaceWindowCoordinator<
  TWindow,
  TOpenArgs extends unknown[] = []
> {
  show(workspaceID: string, ...openArgs: TOpenArgs): Promise<TWindow>;
}

export function createDurableWorkspaceWindowCoordinator<
  TWindow,
  TOpenArgs extends unknown[] = []
>(input: {
  activate(window: TWindow): void;
  find(workspaceID: string): TWindow | null;
  open(workspaceID: string, ...openArgs: TOpenArgs): Promise<TWindow>;
}): DurableWorkspaceWindowCoordinator<TWindow, TOpenArgs> {
  const pendingWindows = new Map<string, Promise<TWindow>>();

  return {
    async show(workspaceID, ...openArgs) {
      const pendingWindow = pendingWindows.get(workspaceID);
      if (pendingWindow) {
        return await pendingWindow;
      }
      const existingWindow = input.find(workspaceID);
      if (existingWindow) {
        input.activate(existingWindow);
        return existingWindow;
      }
      const openWindow = input.open(workspaceID, ...openArgs);
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
