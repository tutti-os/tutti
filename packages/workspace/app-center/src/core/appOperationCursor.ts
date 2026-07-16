import type { WorkspaceAppCenterOperationCursor } from "./appCenterControllerTypes.ts";

export function acceptWorkspaceAppOperationCursor(
  cursors: Map<string, WorkspaceAppCenterOperationCursor>,
  key: string,
  incoming: WorkspaceAppCenterOperationCursor | null | undefined
): boolean | null {
  if (incoming == null) {
    return null;
  }
  if (!isValidOperationCursor(incoming)) {
    return false;
  }
  const current = cursors.get(key);
  const accepted =
    current == null ||
    (incoming.desiredGeneration > current.desiredGeneration &&
      incoming.operationId !== current.operationId) ||
    (incoming.desiredGeneration === current.desiredGeneration &&
      incoming.operationId === current.operationId &&
      incoming.sequence > current.sequence);
  if (!accepted) {
    return false;
  }
  cursors.set(key, incoming);
  return true;
}

function isValidOperationCursor(
  cursor: WorkspaceAppCenterOperationCursor
): boolean {
  return (
    cursor.operationId.trim().length > 0 &&
    Number.isSafeInteger(cursor.desiredGeneration) &&
    cursor.desiredGeneration > 0 &&
    Number.isSafeInteger(cursor.sequence) &&
    cursor.sequence >= 0
  );
}
