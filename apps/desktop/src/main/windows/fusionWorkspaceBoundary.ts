export function fusionWorkspaceRequiresDockReload(
  currentWorkspaceId: string | null,
  nextWorkspaceId: string
): boolean {
  return currentWorkspaceId !== null && currentWorkspaceId !== nextWorkspaceId;
}
