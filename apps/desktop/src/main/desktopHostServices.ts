import type { DesktopLocale } from "../shared/i18n";
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
import {
  isFusionModeEnabled,
  resolveFusionDockVisibility
} from "../shared/featureFlags/catalog.ts";
import {
  createFusionWindowCoordinator,
  type DesktopFusionWindowCoordinator,
  type FusionDockVisibilityMode
} from "./windows/fusionWindowCoordinator.ts";

export interface DesktopHostServices {
  fileDialogs: DesktopFileDialogAccess;
  fusion: DesktopFusionWindowCoordinator;
  preferences: DesktopHostPreferencesState;
  workspaceLaunch: WorkspaceLaunch;
}

export interface CreateDesktopHostServicesOptions {
  appVersion?: string;
  browserNodeGuestPreloadPath?: string;
  enableDevelopmentReloadShortcut?: boolean;
  fallbackLocale: DesktopLocale;
  logger: DesktopLogger;
  tuttidClient: Pick<
    TuttidClient,
    "getDesktopPreferences" | "getStartupWorkspace" | "putDesktopPreferences"
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
    logger: options.logger,
    tuttidClient: options.tuttidClient
  });
  const fileDialogs = createDesktopFileDialogAccess({
    getLocale: () => preferences.getLocale()
  });
  const fusion = createFusionWindowCoordinator({
    active: isFusionModeEnabled(preferences.getFeatureFlags()),
    browserNodeGuestPreloadPath: options.browserNodeGuestPreloadPath,
    enableDevelopmentReloadShortcut:
      options.enableDevelopmentReloadShortcut === true,
    getDockPlacement: () => preferences.getDockPlacement(),
    getDockVisibilityMode: () =>
      resolveFusionDockVisibilityMode(preferences.getFeatureFlags()),
    getLocale: () => preferences.getLocale(),
    getShortcutBinding: () =>
      preferences.getWorkbenchShortcuts().toggleFusionDock,
    getTheme: () => getDesktopThemeState(preferences.getThemeSource()),
    logger: options.logger,
    preloadPath: options.preloadPath,
    rendererUrl: options.rendererUrl,
    subscribePreferences: (listener) => preferences.subscribe(listener),
    workspaceAppPreloadPath: options.workspaceAppPreloadPath
  });
  const workspaceLaunch = createWorkspaceLaunch({
    adapters: createWorkspaceLaunchDesktopAdapters({
      enableDevelopmentReloadShortcut:
        options.enableDevelopmentReloadShortcut === true,
      browserNodeGuestPreloadPath: options.browserNodeGuestPreloadPath,
      getDockPlacement: () => preferences.getDockPlacement(),
      getLocale: () => preferences.getLocale(),
      getTheme: () => getDesktopThemeState(preferences.getThemeSource()),
      preloadPath: options.preloadPath,
      rendererUrl: options.rendererUrl,
      workspaceAppPreloadPath: options.workspaceAppPreloadPath
    }),
    fusion,
    tuttidClient: options.tuttidClient
  });

  return {
    fileDialogs,
    fusion,
    preferences,
    workspaceLaunch
  };
}

function resolveFusionDockVisibilityMode(
  flags: ReturnType<DesktopHostPreferencesState["getFeatureFlags"]>
): FusionDockVisibilityMode {
  switch (resolveFusionDockVisibility(flags)) {
    case "autoHide":
      return "auto-hide";
    case "shortcutOnly":
      return "shortcut-only";
    default:
      return "always";
  }
}
