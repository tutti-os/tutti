import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { initializeDesktopEnvironment } from "./defaults";
import { registerDesktopAppLifecycle } from "./desktopAppLifecycle";
import { createDesktopAppServices } from "./desktopAppServices";
import { startDesktopAppUpdateAnalytics } from "./appUpdateAnalytics.ts";
import { configureApplicationMenu } from "./applicationMenu.ts";
import { connectAgentPowerSaveBlocker } from "./agentPowerSaveBlocker.ts";
import {
  connectDesktopHostPreferencesEventStream,
  createDesktopHostPreferencesEventStreamClient
} from "./desktopHostPreferencesEventStream";
import { exportDesktopDeveloperLogsAndNotify } from "./developerLogsDesktop.ts";
import {
  applyDesktopThemeSource,
  syncDesktopWindowBackgroundColors
} from "./desktopTheme";
import { registerIpcHandlers } from "./ipc/register";
import { flushDesktopLogger, setupDesktopLogger } from "./logging";
import { getSystemDesktopLocale } from "./desktopLocale";
import { openDesktopWorkspaceAppFolder } from "./host/workspaceAppFolderAccess";
import { createWorkspaceFileIconCacheStore } from "./host/workspaceFileIconCacheStore.ts";
import {
  registerWorkspaceFileIconProtocol,
  registerWorkspaceFileIconProtocolScheme
} from "./host/workspaceFileIconProtocol.ts";

export async function bootstrapDesktopApp(): Promise<void> {
  registerWorkspaceFileIconProtocolScheme();
  initializeDesktopEnvironment({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged
  });
  const logger = await setupDesktopLogger();
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const preloadPath = join(currentDir, "../preload/index.cjs");
  const browserNodeGuestPreloadPath = join(
    currentDir,
    "../preload/browser-node-guest.cjs"
  );
  const workspaceAppPreloadPath = join(
    currentDir,
    "../preload/workspace-app.cjs"
  );
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  await app.whenReady();
  const workspaceFileIconCache = createWorkspaceFileIconCacheStore({
    directory: join(app.getPath("userData"), "workspace-file-icons")
  });
  registerWorkspaceFileIconProtocol(workspaceFileIconCache);
  const desktopAppServices = await createDesktopAppServices({
    enableDevelopmentReloadShortcut: Boolean(rendererUrl) && !app.isPackaged,
    fallbackLocale: getSystemDesktopLocale(),
    browserNodeGuestPreloadPath,
    isPackaged: app.isPackaged,
    logger,
    preloadPath,
    rendererUrl,
    workspaceAppPreloadPath
  });
  const theme = applyDesktopThemeSource(
    desktopAppServices.preferences.getThemeSource()
  );
  syncDesktopWindowBackgroundColors();

  void import("electron").then(({ nativeTheme }) => {
    nativeTheme.on("updated", () => {
      if (desktopAppServices.preferences.getThemeSource() !== "system") {
        return;
      }

      syncDesktopWindowBackgroundColors();
    });
  });

  logger.info("desktop app ready", {
    locale: desktopAppServices.preferences.getLocale(),
    rendererUrl: rendererUrl ?? null,
    themeAppearance: theme.appearance,
    themeSource: theme.source
  });
  await flushDesktopLogger();
  await configureApplicationMenu({
    checkForUpdates: () => desktopAppServices.updateService.checkForUpdates(),
    exportDeveloperLogs: () =>
      exportDesktopDeveloperLogsAndNotify(
        desktopAppServices.preferences,
        desktopAppServices.tuttidClient
      ),
    getLocale: () => desktopAppServices.preferences.getLocale(),
    logger
  });

  registerIpcHandlers({
    daemonEndpoint: desktopAppServices.daemonEndpoint,
    fileDialogs: desktopAppServices.fileDialogs,
    logger,
    workspaceFileIconCache,
    tuttidClient: desktopAppServices.tuttidClient,
    openWorkspaceAppFolder: openDesktopWorkspaceAppFolder,
    preferences: desktopAppServices.preferences,
    updateService: desktopAppServices.updateService,
    workspaceLaunch: desktopAppServices.workspaceLaunch
  });
  const hostPreferencesEventStream = connectDesktopHostPreferencesEventStream({
    applyThemeSource: applyDesktopThemeSource,
    eventStreamClient: createDesktopHostPreferencesEventStreamClient(
      desktopAppServices.daemonEndpoint
    ),
    logger,
    preferences: desktopAppServices.preferences,
    updateService: desktopAppServices.updateService,
    syncWindowBackgroundColors: syncDesktopWindowBackgroundColors
  });
  const agentPowerSaveBlocker = connectAgentPowerSaveBlocker({
    eventStreamClient: createDesktopHostPreferencesEventStreamClient(
      desktopAppServices.daemonEndpoint
    ),
    logger,
    tuttidClient: desktopAppServices.tuttidClient,
    preferences: desktopAppServices.preferences
  });

  const appUpdateAnalytics = startDesktopAppUpdateAnalytics({
    tuttidClient: desktopAppServices.tuttidClient,
    onError(error) {
      logger.warn("failed to record app update analytics", {
        error: error instanceof Error ? error.message : String(error)
      });
    },
    updateService: desktopAppServices.updateService
  });

  void desktopAppServices.updateService.configure({
    channel: desktopAppServices.preferences.getUpdateChannel(),
    policy: desktopAppServices.preferences.getUpdatePolicy()
  });

  await desktopAppServices.workspaceLaunch.openStartupWindow();

  registerDesktopAppLifecycle({
    logger,
    tuttid: desktopAppServices.tuttid,
    disposables: [
      hostPreferencesEventStream,
      agentPowerSaveBlocker,
      {
        dispose() {
          appUpdateAnalytics.release();
        }
      }
    ],
    updateService: desktopAppServices.updateService,
    workspaceLaunch: desktopAppServices.workspaceLaunch
  });
}
