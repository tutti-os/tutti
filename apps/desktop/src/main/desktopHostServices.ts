import type { DesktopLocale } from "../shared/i18n";
import { app } from "electron";
import {
  createDesktopHostPreferencesState,
  type DesktopHostPreferencesState
} from "./desktopHostPreferences";
import {
  createDesktopFileDialogAccess,
  type DesktopFileDialogAccess
} from "./host/desktopFileDialogAccess";
import {
  createWorkspaceLaunch,
  type WorkspaceLaunch
} from "./host/workspaceLaunch";
import { createWorkspaceLaunchDesktopAdapters } from "./host/workspaceLaunchDesktopAdapters";
import type { DesktopLogger } from "./logging";
import { getDesktopThemeState } from "./desktopTheme";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { resolveWorkspaceLaunchWindowKind } from "./host/workspaceLaunchMode.ts";

export interface DesktopHostServices {
  fileDialogs: DesktopFileDialogAccess;
  preferences: DesktopHostPreferencesState;
  workspaceLaunch: WorkspaceLaunch;
}

export interface CreateDesktopHostServicesOptions {
  appVersion?: string;
  browserNodeGuestPreloadPath?: string;
  enableDevelopmentReloadShortcut?: boolean;
  fallbackLocale: DesktopLocale;
  isPackaged?: boolean;
  logger: DesktopLogger;
  tuttidClient: Pick<
    TuttidClient,
    | "getDesktopPreferences"
    | "getStartupWorkspace"
    | "putDesktopPreferences"
    | "trackEvents"
  >;
  preloadPath: string;
  rendererUrl?: string;
  workspaceAppPreloadPath?: string;
}

export async function createDesktopHostServices(
  options: CreateDesktopHostServicesOptions
): Promise<DesktopHostServices> {
  const preferences = await createDesktopHostPreferencesState({
    appVersion: options.appVersion,
    fallbackLocale: options.fallbackLocale,
    isPackaged: options.isPackaged,
    logger: options.logger,
    tuttidClient: options.tuttidClient
  });
  const fileDialogs = createDesktopFileDialogAccess({
    getDefaultPath: (name) => app.getPath(name),
    getLocale: () => preferences.getLocale()
  });
  const workspaceLaunch = createWorkspaceLaunch({
    adapters: createWorkspaceLaunchDesktopAdapters({
      enableDevelopmentReloadShortcut:
        options.enableDevelopmentReloadShortcut === true,
      browserNodeGuestPreloadPath: options.browserNodeGuestPreloadPath,
      getDockPlacement: () => preferences.getDockPlacement(),
      getLocale: () => preferences.getLocale(),
      getPrimaryWorkspaceWindowKind: () =>
        resolveWorkspaceLaunchWindowKind(preferences.getFeatureFlags()),
      getTheme: () => getDesktopThemeState(preferences.getThemeSource()),
      preloadPath: options.preloadPath,
      rendererUrl: options.rendererUrl,
      workspaceAppPreloadPath: options.workspaceAppPreloadPath
    }),
    onAnalyticsError(error) {
      options.logger.warn("failed to record workspace UI mode analytics", {
        error: error instanceof Error ? error.message : String(error)
      });
    },
    tuttidClient: options.tuttidClient
  });

  return {
    fileDialogs,
    preferences,
    workspaceLaunch
  };
}
