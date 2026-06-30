import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import {
  initializeDesktopEnvironment,
  resolveDesktopDevelopmentAppName,
  resolveDesktopUserDataPath
} from "./defaults";
import { registerDesktopAppLifecycle } from "./desktopAppLifecycle";
import { createDesktopAppServices } from "./desktopAppServices";
import { startDesktopAppUpdateAnalytics } from "./appUpdateAnalytics.ts";
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
import { ensureSingleInstance } from "./singleInstance";
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

function applyElectronDiagnosticSwitches(): void {
  const remoteDebuggingPort =
    process.env.TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT?.trim();
  if (remoteDebuggingPort) {
    app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
  }

  const jsFlags = process.env.TUTTI_ELECTRON_JS_FLAGS?.trim();
  if (jsFlags) {
    app.commandLine.appendSwitch("js-flags", jsFlags);
  }
}

function focusPrimaryDesktopWindow(): void {
  const target = BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed()
  );
  if (!target) {
    return;
  }
  if (target.isMinimized()) {
    target.restore();
  }
  target.show();
  target.focus();
}

export async function bootstrapDesktopApp(): Promise<void> {
  applyElectronDiagnosticSwitches();
  registerTuttiAssetProtocolScheme();
  registerWorkspaceFileIconProtocolScheme();
  initializeDesktopEnvironment({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged
  });
  const appName = app.getName();
  const userDataPath = resolveDesktopUserDataPath({
    appDataDir: app.getPath("appData"),
    appName
  });
  if (userDataPath) {
    app.setPath("userData", userDataPath);
  }
  const developmentAppName = resolveDesktopDevelopmentAppName(appName);
  if (developmentAppName) {
    app.setName(developmentAppName);
  }
  const logger = await setupDesktopLogger();

  // A single live desktop instance per environment. The managed tuttid daemon is
  // a global singleton (one pid/listener file per env root); a second instance
  // would otherwise reap the first instance's live daemon as a "stale" orphan,
  // breaking the first instance until it is restarted manually.
  const isPrimaryInstance = ensureSingleInstance({
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    quit: () => app.quit(),
    onSecondInstance: (handler) => {
      app.on("second-instance", handler);
    },
    focusPrimaryWindow: focusPrimaryDesktopWindow
  });
  if (!isPrimaryInstance) {
    logger.info(
      "secondary tutti instance detected; focusing existing window and quitting"
    );
    return;
  }

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
    checkForUpdates: () => desktopAppServices.updateService.checkForUpdates(),
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
