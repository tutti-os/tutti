import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences.ts";
import type { DesktopLogger } from "../logging.ts";
import {
  createWorkspaceLaunch,
  type WorkspaceLaunch,
  type WorkspaceLaunchAdapters
} from "./workspaceLaunch.ts";
import { resolveWorkspaceLaunchWindowOptions } from "./workspaceLaunchMode.ts";

export interface CreateDesktopWorkspaceLaunchOptions {
  adapters: WorkspaceLaunchAdapters;
  logger: Pick<DesktopLogger, "warn">;
  preferences: Pick<DesktopHostPreferencesState, "getFeatureFlags">;
  tuttidClient: Pick<TuttidClient, "getStartupWorkspace" | "trackEvents">;
}

export function createDesktopWorkspaceLaunch(
  options: CreateDesktopWorkspaceLaunchOptions
): WorkspaceLaunch {
  return createWorkspaceLaunch({
    adapters: options.adapters,
    getPrimaryWorkspaceWindowOptions: () =>
      resolveWorkspaceLaunchWindowOptions(
        options.preferences.getFeatureFlags()
      ),
    onAnalyticsError(error) {
      options.logger.warn("failed to record workspace UI mode analytics", {
        error: error instanceof Error ? error.message : String(error)
      });
    },
    tuttidClient: options.tuttidClient
  });
}
