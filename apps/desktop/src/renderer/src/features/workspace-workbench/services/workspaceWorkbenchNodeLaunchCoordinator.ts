import { WorkspaceScopedRegistrationRegistry } from "./internal/workspaceScopedRegistrationRegistry.ts";

export interface WorkspaceWorkbenchNodeLaunchRequest {
  dockEntryId?: string;
  launchSource?: string;
  payload?: unknown;
  typeId: string;
  workspaceId: string;
}

export type WorkspaceWorkbenchNodeLaunchHandler = (
  request: WorkspaceWorkbenchNodeLaunchRequest
) => Promise<boolean> | boolean;

const launchHandlers =
  new WorkspaceScopedRegistrationRegistry<WorkspaceWorkbenchNodeLaunchHandler>();

export function registerWorkspaceWorkbenchNodeLaunchHandler(
  workspaceId: string,
  handler: WorkspaceWorkbenchNodeLaunchHandler
): () => void {
  return launchHandlers.register(workspaceId, handler);
}

export async function requestWorkspaceWorkbenchNodeLaunch(
  request: WorkspaceWorkbenchNodeLaunchRequest
): Promise<boolean> {
  const normalizedWorkspaceId = request.workspaceId.trim();
  const normalizedTypeId = request.typeId.trim();
  if (!normalizedWorkspaceId || !normalizedTypeId) {
    return false;
  }
  const handler = launchHandlers.get(normalizedWorkspaceId);
  if (!handler) {
    return false;
  }

  return handler({
    ...(request.dockEntryId?.trim()
      ? { dockEntryId: request.dockEntryId.trim() }
      : {}),
    ...(request.launchSource?.trim()
      ? { launchSource: request.launchSource.trim() }
      : {}),
    payload: request.payload,
    typeId: normalizedTypeId,
    workspaceId: normalizedWorkspaceId
  });
}
