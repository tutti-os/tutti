import type {
  DesktopFeatureFlags,
  DesktopWorkspaceUiMode
} from "../../shared/preferences/index.ts";
import { resolveDesktopWorkspaceUiMode } from "../../shared/featureFlags/catalog.ts";

export type WorkspaceLaunchWindowKind = "agent" | "workspace";

export function resolveWorkspaceLaunchWindowOptions(
  featureFlags: DesktopFeatureFlags
): {
  windowKind: WorkspaceLaunchWindowKind;
  workspaceUiMode: DesktopWorkspaceUiMode;
} {
  const workspaceUiMode = resolveDesktopWorkspaceUiMode(featureFlags);
  return {
    windowKind: workspaceUiMode === "agent" ? "agent" : "workspace",
    workspaceUiMode
  };
}
