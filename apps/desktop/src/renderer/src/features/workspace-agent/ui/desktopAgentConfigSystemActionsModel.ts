import type { DesktopWorkspaceUiMode } from "@shared/preferences";

export function shouldShowDesktopAgentConfigSystemActions(
  workspaceUiMode: DesktopWorkspaceUiMode
): boolean {
  return workspaceUiMode === "agent";
}
