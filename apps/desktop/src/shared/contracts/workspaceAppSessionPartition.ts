export const workspaceAppSessionPartitionPrefix = "persist:tutti-app:";

export interface WorkspaceAppSessionPartitionIdentity {
  appID: string;
  workspaceID: string;
}

export function createWorkspaceAppSessionPartition(
  identity: WorkspaceAppSessionPartitionIdentity
): string {
  return `${workspaceAppSessionPartitionPrefix}${encodeURIComponent(
    identity.workspaceID
  )}:${encodeURIComponent(identity.appID)}`;
}

export function parseWorkspaceAppSessionPartition(
  partition: string | null | undefined
): WorkspaceAppSessionPartitionIdentity | null {
  if (!partition?.startsWith(workspaceAppSessionPartitionPrefix)) {
    return null;
  }
  const value = partition.slice(workspaceAppSessionPartitionPrefix.length);
  const separator = value.indexOf(":");
  if (separator <= 0 || separator >= value.length - 1) {
    return null;
  }
  try {
    const workspaceID = decodeURIComponent(value.slice(0, separator));
    const appID = decodeURIComponent(value.slice(separator + 1));
    return workspaceID && appID ? { appID, workspaceID } : null;
  } catch {
    return null;
  }
}

export function isWorkspaceAppSessionPartition(
  partition: string | null | undefined
): partition is string {
  return parseWorkspaceAppSessionPartition(partition) !== null;
}

export function hasWorkspaceAppSessionPartitionPrefix(
  partition: string | null | undefined
): partition is string {
  return partition?.startsWith(workspaceAppSessionPartitionPrefix) === true;
}
