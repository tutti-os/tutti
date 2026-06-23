import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { initializeDesktopEnvironment } from "./defaults";
import { registerDesktopAppLifecycle } from "./desktopAppLifecycle";
import { createDesktopAppServices } from "./desktopAppServices";
import { configureApplicationMenu } from "./applicationMenu.ts";
import { connectAgentPowerSaveBlocker } from "./agentPowerSaveBlocker.ts";
import {
  connectDesktopHostPreferencesEventStream,
  createDesktopHostPreferencesEventStreamClient
} from "./desktopHostPreferencesEventStream";
import {
  createDesktopDeveloperLogsService,
  exportDesktopDeveloperLogsAndNotify
} from "./developerLogsDesktop.ts";
import {
  applyDesktopThemeSource,
  syncDesktopWindowBackgroundColors
} from "./desktopTheme";
import { registerIpcHandlers } from "./ipc/register";
import { flushDesktopLogger, setupDesktopLogger } from "./logging";
import { getSystemDesktopLocale } from "./desktopLocale";
import { openDesktopWorkspaceAppFolder } from "./host/workspaceAppFolderAccess";
import { openPerfMonitorDevToolsWindow } from "./windows/perfMonitorDevToolsWindow.ts";
import { createTranslator } from "../shared/i18n/index.ts";
import {
  registerTuttiAssetProtocol,
  registerTuttiAssetProtocolScheme
} from "./host/tuttiAssetProtocol.ts";
import { createWorkspaceFileIconCacheStore } from "./host/workspaceFileIconCacheStore.ts";
import {
  registerWorkspaceFileIconProtocol,
  registerWorkspaceFileIconProtocolScheme
} from "./host/workspaceFileIconProtocol.ts";

function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/iu.test(value?.trim() ?? "");
}

export async function bootstrapDesktopApp(): Promise<void> {
  registerTuttiAssetProtocolScheme();
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
  registerTuttiAssetProtocol();
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
    clearDeveloperLogs: () =>
      createDesktopDeveloperLogsService(
        desktopAppServices.preferences,
        desktopAppServices.tuttidClient
      ).clearLogs(),
    exportDeveloperLogs: () =>
      exportDesktopDeveloperLogsAndNotify(
        desktopAppServices.preferences,
        desktopAppServices.tuttidClient
      ),
    getLocale: () => desktopAppServices.preferences.getLocale(),
    logger,
    openPerfMonitorDevTools:
      rendererUrl && envFlagEnabled(process.env.TUTTI_ENABLE_PERF_MONITOR)
        ? (ownerWindow) => {
            const translator = createTranslator(
              desktopAppServices.preferences.getLocale()
            );
            openPerfMonitorDevToolsWindow({
              logger,
              ownerWindow:
                ownerWindow instanceof BrowserWindow ? ownerWindow : null,
              rendererUrl,
              title: translator.t("desktop.menu.openPerfMonitor")
            });
          }
        : undefined
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

  await desktopAppServices.workspaceLaunch.openStartupWindow();

  registerDesktopAppLifecycle({
    logger,
    tuttid: desktopAppServices.tuttid,
    disposables: [hostPreferencesEventStream, agentPowerSaveBlocker],
    updateService: desktopAppServices.updateService,
    workspaceLaunch: desktopAppServices.workspaceLaunch
  });
}
