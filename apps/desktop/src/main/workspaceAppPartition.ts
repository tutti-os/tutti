export const workspaceAppBrowserPartitionPrefix = "persist:tutti-app:";

export interface WorkspaceAppSessionPartitionIdentity {
  appID: string;
  workspaceID: string;
}

export function parseWorkspaceAppSessionPartition(
  partition: string | null | undefined
): WorkspaceAppSessionPartitionIdentity | null {
  if (
    !partition?.startsWith(workspaceAppBrowserPartitionPrefix) ||
    partition !== partition.trim()
  ) {
    return null;
  }
  const value = partition.slice(workspaceAppBrowserPartitionPrefix.length);
  const separator = value.indexOf(":");
  if (separator <= 0 || separator >= value.length - 1) {
    return null;
  }
  try {
    const workspaceID = decodeURIComponent(value.slice(0, separator));
    const appID = decodeURIComponent(value.slice(separator + 1));
    if (!workspaceID || !appID) {
      return null;
    }
    const canonical = `${workspaceAppBrowserPartitionPrefix}${encodeURIComponent(
      workspaceID
    )}:${encodeURIComponent(appID)}`;
    return partition === canonical ? { appID, workspaceID } : null;
  } catch {
    return null;
  }
}

export function isWorkspaceAppSessionPartitionAllowed(
  partition: string | null | undefined,
  expectedWorkspaceID: string
): boolean {
  return (
    parseWorkspaceAppSessionPartition(partition)?.workspaceID ===
    expectedWorkspaceID
  );
}
