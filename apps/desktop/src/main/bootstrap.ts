import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  protocol,
  shell
} from "electron";
import {
  createDesktopUpdateAdmissionController,
  registerDesktopFeatureAvailabilityIpc,
  type DesktopUpdateAdmissionController
} from "@tutti-os/desktop-update-admission/electron-main";
import {
  createDesktopFeatureAvailabilityRuntime,
  type MutableDesktopFeatureAvailabilityRuntime
} from "@tutti-os/desktop-update-admission/feature-availability";
import { resolveMinimumVersionRuntimeTarget } from "@tutti-os/desktop-update-admission/core";
import { resolveDesktopUpdateAdmissionDevelopment } from "@tutti-os/desktop-update-admission/development";
import {
  initializeDesktopEnvironment,
  resolveDesktopDevelopmentAppName,
  resolveDesktopLoginCallbackUrl,
  resolveDesktopLoginProtocolClientRegistration,
  resolveDesktopUserDataPath
} from "./defaults";
import { registerDesktopAppLifecycle } from "./desktopAppLifecycle";
import {
  createDesktopAppServices,
  startDesktopDaemonRuntime
} from "./desktopAppServices";
import { createDesktopDaemonRuntime } from "./desktopDaemonRuntime.ts";
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
  getDesktopThemeState,
  syncDesktopWindowBackgroundColors
} from "./desktopTheme";
import { registerIpcHandlers } from "./ipc/register";
import { flushDesktopLogger, setupDesktopLogger } from "./logging";
import { ensureMacosApplicationInstalled } from "./macosApplicationInstallGuard.ts";
import { prepareDesktopCliTarget } from "./cli/cliInstaller.ts";
import { ensureSingleInstance } from "./singleInstance";
import {
  completeDesktopLoginCallbackUrl,
  findDesktopLoginCallbackUrl,
  isDesktopAppOpenUrl
} from "./desktopLoginCallback";
import { getSystemDesktopLocale } from "./desktopLocale";
import { openDesktopWorkspaceAppFolder } from "./host/workspaceAppFolderAccess";
import { openPerfMonitorDevToolsWindow } from "./windows/perfMonitorDevToolsWindow.ts";
import { createTranslator } from "../shared/i18n/index.ts";
import { registerTuttiAssetProtocol } from "./host/tuttiAssetProtocol.ts";
import { desktopCustomProtocolSchemes } from "./host/desktopCustomProtocolSchemes.ts";
import { createWorkspaceFileIconCacheStore } from "./host/workspaceFileIconCacheStore.ts";
import { registerWorkspaceFileIconProtocol } from "./host/workspaceFileIconProtocol.ts";
import { applyDesktopElectronPlatformCompatibility } from "./electronPlatformCompatibility.ts";
import { createAppUpdateService } from "./update/appUpdateService.ts";
import { createTuttidDesktopUpdateAdmissionBackend } from "./update/desktopUpdateAdmissionBackend.ts";
import {
  getWorkspaceWindowKind,
  syncWorkspaceWindowTitleBarOverlayColors
} from "./windows/workspaceWindow.ts";
import {
  resolveDesktopDistribution,
  resolveDesktopManualDownloadUrl
} from "../shared/distribution/desktopDistribution.ts";

function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/iu.test(value?.trim() ?? "");
}

function syncDesktopWindowThemeColors(): void {
  syncDesktopWindowBackgroundColors();
  syncWorkspaceWindowTitleBarOverlayColors(getDesktopThemeState().appearance);
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
  applyDesktopElectronPlatformCompatibility(app.commandLine);
  applyElectronDiagnosticSwitches();
  initializeDesktopEnvironment({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged
  });
  protocol.registerSchemesAsPrivileged(desktopCustomProtocolSchemes);
  const loginCallbackUrl = resolveDesktopLoginCallbackUrl();
  const protocolClientRegistration =
    resolveDesktopLoginProtocolClientRegistration({
      isPackaged: app.isPackaged
    });
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(protocolClientRegistration.scheme);
  }
  const handleLoginCallbackUrl = (url: string): void => {
    void completeDesktopLoginCallbackUrl(url).catch(() => undefined);
  };
  app.on("open-url", (event, url) => {
    const isLoginCallback = url.startsWith(loginCallbackUrl);
    if (
      !isLoginCallback &&
      !isDesktopAppOpenUrl(url, protocolClientRegistration.scheme)
    ) {
      return;
    }
    event.preventDefault();
    if (isLoginCallback) {
      handleLoginCallbackUrl(url);
    }
    focusPrimaryDesktopWindow();
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
  // Preload cannot import Electron's main-only `app` module. Publish the
  // already-resolved native name through the process environment so every
  // renderer can use the same value as the Windows title bar.
  process.env.TUTTI_DESKTOP_APP_NAME = app.getName();
  const logger = await setupDesktopLogger();

  // A single live desktop instance per environment. The managed tuttid daemon is
  // a global singleton (one pid/listener file per env root); a second instance
  // would otherwise reap the first instance's live daemon as a "stale" orphan,
  // breaking the first instance until it is restarted manually.
  const isPrimaryInstance = ensureSingleInstance({
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    quit: () => app.quit(),
    onSecondInstance: (handler) => {
      app.on("second-instance", (_event, commandLine) => handler(commandLine));
    },
    handleSecondInstanceArgv: (argv) => {
      const callbackUrl = findDesktopLoginCallbackUrl(argv, loginCallbackUrl);
      if (callbackUrl) {
        handleLoginCallbackUrl(callbackUrl);
      }
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
  const capturePreloadPath = join(currentDir, "../preload/capture.cjs");
  const minimumVersionPreloadPath = join(
    currentDir,
    "../preload/minimum-version.cjs"
  );
  const browserNodeGuestPreloadPath = join(
    currentDir,
    "../preload/browser-node-guest.cjs"
  );
  const workspaceAppPreloadPath = join(
    currentDir,
    "../preload/workspace-app.cjs"
  );
  const isFeatureAvailabilityWindow = (window: BrowserWindow): boolean =>
    !window.isDestroyed() && getWorkspaceWindowKind(window) !== null;
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  await app.whenReady();
  const systemLocale = getSystemDesktopLocale();
  const translator = createTranslator(systemLocale);
  const desktopDistribution = resolveDesktopDistribution({
    platform: process.platform,
    windowsStore: (process as NodeJS.Process & { windowsStore?: boolean })
      .windowsStore
  });
  const canContinueStartup = await ensureMacosApplicationInstalled({
    appPath: process.execPath,
    isPackaged: app.isPackaged,
    locale: systemLocale,
    logger
  });
  if (!canContinueStartup) {
    return;
  }

  const desktopUpdateAdmission = resolveDesktopUpdateAdmissionDevelopment({
    applicationVersion: app.getVersion(),
    env: process.env,
    isPackaged: app.isPackaged
  });
  const featureAvailabilityTarget = resolveMinimumVersionRuntimeTarget(
    process.platform,
    process.arch
  );
  const managedAdmissionTarget = featureAvailabilityTarget;
  const workspaceAppCliPath =
    process.platform === "win32"
      ? prepareDesktopCliTarget({ isPackaged: app.isPackaged })
      : undefined;
  const daemonRuntime = await startDesktopDaemonRuntime({
    daemonRuntime: createDesktopDaemonRuntime({
      ...(workspaceAppCliPath ? { workspaceAppCliPath } : {}),
      desktopUpdateAdmission: managedAdmissionTarget
        ? {
            ...managedAdmissionTarget,
            currentVersion: desktopUpdateAdmission.runtime.currentVersion,
            managed: true,
            packaged: app.isPackaged
          }
        : undefined
    }),
    logger
  });
  let admissionStartupActive = true;
  let admissionDaemonStopStarted = false;
  const stopAdmissionDaemonBeforeExit = (event: Electron.Event): void => {
    if (!admissionStartupActive || admissionDaemonStopStarted) {
      return;
    }
    event.preventDefault();
    admissionDaemonStopStarted = true;
    void daemonRuntime.tuttid.stop().finally(() => app.exit(0));
  };
  app.on("before-quit", stopAdmissionDaemonBeforeExit);

  const featureAvailabilityRuntime: MutableDesktopFeatureAvailabilityRuntime<"tutti-desktop"> | null =
    managedAdmissionTarget
      ? createDesktopFeatureAvailabilityRuntime({
          identity: {
            ...managedAdmissionTarget,
            currentVersion: desktopUpdateAdmission.runtime.currentVersion,
            product: "tutti-desktop"
          },
          logger: {
            error: (message) => logger.error(message),
            info: (message) => logger.info(message)
          }
        })
      : null;
  const featureAvailabilityIpc = featureAvailabilityRuntime
    ? registerDesktopFeatureAvailabilityIpc({
        electron: {
          broadcast: (channel, snapshot) => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (isFeatureAvailabilityWindow(window)) {
                window.webContents.send(channel, snapshot);
              }
            }
          },
          ipcMain,
          isTrustedSender: (sender) => {
            const window = BrowserWindow.fromWebContents(sender);
            return window !== null && isFeatureAvailabilityWindow(window);
          }
        },
        runtime: featureAvailabilityRuntime
      })
    : null;
  const updateService = createAppUpdateService(undefined, {
    currentVersion: desktopUpdateAdmission.runtime.currentVersion,
    developmentScenario: desktopUpdateAdmission.scenario,
    supportsUpdates: desktopDistribution === "store" ? false : undefined,
    unsupportedMessage:
      desktopDistribution === "store"
        ? translator.t("updates.storeManaged")
        : undefined
  });
  let desktopAppServices: Awaited<
    ReturnType<typeof createDesktopAppServices>
  > | null = null;
  let releaseStartupGate: (() => void) | null = null;
  let minimumVersionController: DesktopUpdateAdmissionController | null =
    createDesktopUpdateAdmissionController({
      backend: createTuttidDesktopUpdateAdmissionBackend(
        daemonRuntime.tuttidClient
      ),
      electron: { app, BrowserWindow, ipcMain, shell },
      featureAvailability: featureAvailabilityRuntime ?? undefined,
      listBusinessWindows: () => BrowserWindow.getAllWindows(),
      logger,
      manualDownloadUrl: (response) => {
        return resolveDesktopManualDownloadUrl({
          channel: response.channel === "rc" ? "rc" : "stable",
          distribution: desktopDistribution,
          platform: process.platform
        });
      },
      onPolicyReleased: () => {
        if (releaseStartupGate) {
          const release = releaseStartupGate;
          releaseStartupGate = null;
          release();
        }
      },
      preloadPath: minimumVersionPreloadPath,
      product: "tutti-desktop",
      runtime: desktopUpdateAdmission.runtime,
      rendererFilePath: join(currentDir, "../renderer/minimum-version.html"),
      rendererUrl: rendererUrl
        ? `${rendererUrl}/minimum-version.html`
        : undefined,
      updateService: {
        acquireMandatorySession: (input) =>
          updateService.acquireMandatorySession(input),
        getState: () => updateService.getState(),
        subscribe: (listener) =>
          updateService.onStateChanged((state) => listener(state))
      }
    });
  const startupBlocked = await minimumVersionController.runStartupCheck();
  if (startupBlocked) {
    await new Promise<void>((resolve) => {
      releaseStartupGate = resolve;
    });
  }

  const workspaceFileIconCache = createWorkspaceFileIconCacheStore({
    directory: join(app.getPath("userData"), "workspace-file-icons")
  });
  registerTuttiAssetProtocol();
  registerWorkspaceFileIconProtocol(workspaceFileIconCache);
  desktopAppServices = await createDesktopAppServices({
    appVersion: app.getVersion(),
    enableDevelopmentReloadShortcut: Boolean(rendererUrl) && !app.isPackaged,
    fallbackLocale: systemLocale,
    browserNodeGuestPreloadPath,
    capturePreloadPath,
    captureRendererFilePath: join(currentDir, "../renderer/capture.html"),
    startedDaemonRuntime: daemonRuntime,
    isPackaged: app.isPackaged,
    logger,
    preloadPath,
    rendererUrl,
    updateService,
    workspaceAppPreloadPath
  });
  const theme = applyDesktopThemeSource(
    desktopAppServices.preferences.getThemeSource()
  );
  syncDesktopWindowThemeColors();

  void import("electron").then(({ nativeTheme }) => {
    nativeTheme.on("updated", () => {
      if (desktopAppServices.preferences.getThemeSource() !== "system") {
        return;
      }

      syncDesktopWindowThemeColors();
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
    exportDeveloperLogs: (input) =>
      exportDesktopDeveloperLogsAndNotify(
        desktopAppServices.preferences,
        desktopAppServices.tuttidClient,
        input
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

  const ipcDisposables = await registerIpcHandlers({
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
    syncWindowBackgroundColors: syncDesktopWindowThemeColors
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

  let businessWindowAllowed = false;
  let businessWindowOpened = false;
  const openBusinessWindow = async () => {
    businessWindowAllowed = true;
    if (!businessWindowOpened) {
      businessWindowOpened = true;
      await desktopAppServices.workspaceLaunch.openStartupWindow();
    } else {
      focusPrimaryDesktopWindow();
    }
  };
  const checkMinimumVersionAfterRestore = () => {
    void minimumVersionController?.checkAfterForegroundRestore();
  };
  powerMonitor.on("resume", checkMinimumVersionAfterRestore);
  app.on("browser-window-focus", checkMinimumVersionAfterRestore);

  registerDesktopAppLifecycle({
    canOpenBusinessWindow: () => businessWindowAllowed,
    logger,
    tuttid: desktopAppServices.tuttid,
    disposables: [
      ...ipcDisposables,
      desktopAppServices.capture,
      ...(featureAvailabilityIpc ? [featureAvailabilityIpc] : []),
      hostPreferencesEventStream,
      agentPowerSaveBlocker,
      {
        async shutdown() {
          featureAvailabilityRuntime?.dispose();
        },
        dispose() {
          featureAvailabilityRuntime?.dispose();
        }
      },
      {
        dispose() {
          appUpdateAnalytics.release();
        }
      },
      {
        dispose() {
          powerMonitor.removeListener(
            "resume",
            checkMinimumVersionAfterRestore
          );
          app.removeListener(
            "browser-window-focus",
            checkMinimumVersionAfterRestore
          );
          minimumVersionController?.dispose();
          minimumVersionController = null;
        }
      }
    ],
    updateService: desktopAppServices.updateService,
    workspaceLaunch: desktopAppServices.workspaceLaunch
  });
  admissionStartupActive = false;
  app.removeListener("before-quit", stopAdmissionDaemonBeforeExit);

  await updateService.configure({
    channel: desktopAppServices.preferences.getUpdateChannel(),
    policy: desktopAppServices.preferences.getUpdatePolicy()
  });
  await openBusinessWindow();
}
