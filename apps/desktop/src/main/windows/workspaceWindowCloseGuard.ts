export function supportsWorkspaceWindowCloseGuard(
  platform: NodeJS.Platform
): boolean {
  return platform === "darwin" || platform === "win32";
}
