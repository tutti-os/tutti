import { WorkspaceScopedRegistrationRegistry } from "./internal/workspaceScopedRegistrationRegistry.ts";

export type WorkspaceMessageCenterOpenHandler = () => void;

const openHandlers =
  new WorkspaceScopedRegistrationRegistry<WorkspaceMessageCenterOpenHandler>();

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
  return openHandlers.register(workspaceId, handler);
}

export function requestWorkspaceMessageCenterOpen(
  workspaceId: string
): boolean {
  const handler = openHandlers.get(workspaceId);
  if (!handler) {
    return false;
  }

  handler();
  return true;
}
