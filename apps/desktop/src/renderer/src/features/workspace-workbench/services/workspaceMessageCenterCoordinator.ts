export type WorkspaceMessageCenterOpenHandler = () => void;

const openHandlersByWorkspaceId = new Map<
  string,
  WorkspaceMessageCenterOpenHandler
>();

function noop(): void {}

/**
 * Lets the workspace chrome (which owns the message center drawer state) register
 * a handler so other parts of the workbench can request opening it without
 * threading props through the component tree. Mirrors the agent GUI launch
 * coordinator pattern.
 */
export function registerWorkspaceMessageCenterOpenHandler(
  workspaceId: string,
  handler: WorkspaceMessageCenterOpenHandler
): () => void {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    return noop;
  }

  openHandlersByWorkspaceId.set(normalizedWorkspaceId, handler);
  return () => {
    if (openHandlersByWorkspaceId.get(normalizedWorkspaceId) === handler) {
      openHandlersByWorkspaceId.delete(normalizedWorkspaceId);
    }
  };
}

export function requestWorkspaceMessageCenterOpen(
  workspaceId: string
): boolean {
  const handler = openHandlersByWorkspaceId.get(workspaceId.trim());
  if (!handler) {
    return false;
  }

  handler();
  return true;
}
