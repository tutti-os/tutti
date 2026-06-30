import { BrowserWindow, app, ipcMain, session, shell } from "electron";
import {
  installBrowserWebviewSecurity,
  isBrowserNodeWebviewAttach
} from "@tutti-os/browser-node/electron-main";
import { registerBrowserGuestWebContents } from "../browser/browserGuestRegistry";
import { registerTuttiAssetProtocolForSession } from "../host/tuttiAssetProtocol.ts";
import { registerWorkspaceAppGuestWebContents } from "../ipc/workspaceAppContext";
import { resolveDesktopWindowBackgroundColor } from "../desktopTheme";
import { getDesktopLogger } from "../logging";
import type { DesktopLocale } from "../../shared/i18n";
import type { DesktopDockPlacement } from "../../shared/preferences/index.ts";
import type { DesktopThemeState } from "../../shared/theme/index.ts";
import {
  applyDesktopWindowIntent,
  createWorkspaceWindowIntent,
  encodeDesktopWindowIntent
} from "../../shared/contracts/windowIntent";
import {
  desktopIpcChannels,
  type DesktopHostWindowCloseRequestPayload,
  type DesktopHostWindowCloseRequestResolutionPayload
} from "../../shared/contracts/ipc";
import { installWorkspaceWindowDevelopmentReloadShortcut } from "./workspaceWindowReload.ts";
import { resolvePackagedWorkspaceRendererIndexPath } from "./workspaceWindowPaths.ts";

export const workspaceAppBrowserPartitionPrefix = "persist:tutti-app:";

export interface CreateWorkspaceWindowOptions {
  browserNodeGuestPreloadPath?: string;
  enableDevelopmentReloadShortcut?: boolean;
  locale: DesktopLocale;
  preloadPath: string;
  rendererUrl?: string;
  theme: DesktopThemeState;
  workspaceAppPreloadPath?: string;
  workspaceID: string;
}

const workspaceWindows = new Set<BrowserWindow>();
const workspaceWindowQuitCloseTimeoutMs = 5_000;
let workspaceWindowQuitCloseRequestSequence = 0;
const workspaceWindowHeaderHeightPx = 52;
const workspaceWindowMacTrafficLightInsetPx = 16;
const workspaceWindowMacTrafficLightSizePx = 12;
const workspaceWindowMacTrafficLightPositionY =
  (workspaceWindowHeaderHeightPx - workspaceWindowMacTrafficLightSizePx) / 2;

export function createWorkspaceWindow(
  options: CreateWorkspaceWindowOptions
): BrowserWindow {
  const logger = getDesktopLogger();
  const workspaceWindow = new BrowserWindow({
    backgroundColor: resolveDesktopWindowBackgroundColor(),
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: {
            x: workspaceWindowMacTrafficLightInsetPx,
            y: workspaceWindowMacTrafficLightPositionY
          }
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: options.preloadPath,
      sandbox: false,
      webviewTag: true
    }
  });

  const pendingWorkspaceAppGuestPartitions: (string | null | undefined)[] = [];
  installBrowserWebviewSecurity({
    allowedSessionPartitions: {
      additionalAllowedPrefixes: [workspaceAppBrowserPartitionPrefix]
    },
    contents: workspaceWindow.webContents,
    logger,
    onGuestAttached: (guestContents) => {
      registerBrowserGuestWebContents(workspaceWindow, guestContents, logger);
      const workspaceAppPartition = pendingWorkspaceAppGuestPartitions.shift();
      if (workspaceAppPartition !== undefined) {
        registerWorkspaceAppGuestWebContents(
          workspaceWindow,
          guestContents,
          logger,
          workspaceAppPartition
        );
      }
    },
    openExternal: (url) => shell.openExternal(url),
    resolvePreload({ params }) {
      const workspaceAppPartition = params.partition;
      if (
        options.workspaceAppPreloadPath &&
        isWorkspaceAppSessionPartition(workspaceAppPartition)
      ) {
        registerTuttiAssetProtocolForSession(
          session.fromPartition(workspaceAppPartition)
        );
        pendingWorkspaceAppGuestPartitions.push(workspaceAppPartition);
        logger.info("applying workspace app guest preload", {
          partition: workspaceAppPartition,
          preloadPath: options.workspaceAppPreloadPath,
          src: params.src ?? null
        });
        return options.workspaceAppPreloadPath;
      }
      if (
        options.browserNodeGuestPreloadPath &&
        isBrowserNodeWebviewAttach(params, {
          additionalAllowedPrefixes: [workspaceAppBrowserPartitionPrefix]
        }) &&
        !isWorkspaceAppSessionPartition(params.partition)
      ) {
        logger.info("applying browser node guest preload", {
          partition: params.partition ?? null,
          preloadPath: options.browserNodeGuestPreloadPath,
          src: params.src ?? null
        });
        return options.browserNodeGuestPreloadPath;
      }
      return null;
    }
  });

  installWorkspaceWindowDevelopmentReloadShortcut(workspaceWindow, {
    enabled: options.enableDevelopmentReloadShortcut === true
  });
  workspaceWindows.add(workspaceWindow);
  workspaceWindow.once("closed", () => {
    workspaceWindows.delete(workspaceWindow);
  });

  if (process.platform === "darwin") {
    let resizeLayoutTimer: ReturnType<typeof setTimeout> | null = null;
    const sendHostWindowLayout = () => {
      if (
        workspaceWindow.isDestroyed() ||
        workspaceWindow.webContents.isDestroyed()
      ) {
        return;
      }

      workspaceWindow.webContents.send(desktopIpcChannels.host.window.layout, {
        compactTitlebar: workspaceWindow.isFullScreen()
      });
    };
    const scheduleHostWindowLayout = () => {
      if (resizeLayoutTimer !== null) {
        clearTimeout(resizeLayoutTimer);
      }

      resizeLayoutTimer = setTimeout(() => {
        resizeLayoutTimer = null;
        sendHostWindowLayout();
      }, 50);
    };

    workspaceWindow.on("maximize", sendHostWindowLayout);
    workspaceWindow.on("unmaximize", sendHostWindowLayout);
    workspaceWindow.on("enter-full-screen", sendHostWindowLayout);
    workspaceWindow.on("leave-full-screen", sendHostWindowLayout);
    workspaceWindow.on("resize", scheduleHostWindowLayout);
    workspaceWindow.webContents.on("did-finish-load", sendHostWindowLayout);

    const sendHostWindowMinimizeState = (minimized: boolean) => {
      if (
        workspaceWindow.isDestroyed() ||
        workspaceWindow.webContents.isDestroyed()
      ) {
        return;
      }

      workspaceWindow.webContents.send(
        desktopIpcChannels.host.window.minimizeState,
        { minimized }
      );
    };

    workspaceWindow.on("minimize", () => sendHostWindowMinimizeState(true));
    workspaceWindow.on("restore", () => sendHostWindowMinimizeState(false));

    // The renderer's first handling of this IPC message pays a one-time
    // cold-start cost (lazy JS compilation, style recalculation, etc.),
    // which is slow enough to miss the start of the real minimize
    // animation. Replay it once, harmlessly, shortly after load so that
    // path is already warm by the time the user actually minimizes.
    workspaceWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        sendHostWindowMinimizeState(true);
        setTimeout(() => sendHostWindowMinimizeState(false), 32);
      }, 1_000);
    });
  }

  return workspaceWindow;
}

export function loadWorkspaceWindowContent(
  workspaceWindow: BrowserWindow,
  options: Pick<
    CreateWorkspaceWindowOptions,
    "locale" | "rendererUrl" | "workspaceID"
  > & {
    dockPlacement: DesktopDockPlacement;
    theme: DesktopThemeState;
  }
): void {
  const windowIntentSearchOptions = {
    dockPlacement: options.dockPlacement,
    locale: options.locale,
    themeAppearance: options.theme.appearance,
    themeSource: options.theme.source
  };
  if (options.rendererUrl) {
    void workspaceWindow.loadURL(
      applyDesktopWindowIntent(
        options.rendererUrl,
        createWorkspaceWindowIntent(options.workspaceID),
        windowIntentSearchOptions
      )
    );
    return;
  }

  void workspaceWindow.loadFile(
    resolvePackagedWorkspaceRendererIndexPath(app.getAppPath()),
    {
      search: encodeDesktopWindowIntent(
        createWorkspaceWindowIntent(options.workspaceID),
        windowIntentSearchOptions
      )
    }
  );
}

export function requestWorkspaceWindowCloseFromCommandShortcut(
  workspaceWindow: BrowserWindow
): void {
  sendWorkspaceWindowCloseRequest(workspaceWindow, { reason: "window-close" });
}

export async function requestWorkspaceWindowsClose(
  payload: DesktopHostWindowCloseRequestPayload
): Promise<"approved" | "blocked"> {
  const results = await Promise.all(
    Array.from(workspaceWindows).map((workspaceWindow) =>
      requestWorkspaceWindowClose(workspaceWindow, payload)
    )
  );
  return results.every((result) => result === "approved")
    ? "approved"
    : "blocked";
}

function requestWorkspaceWindowClose(
  workspaceWindow: BrowserWindow,
  payload: DesktopHostWindowCloseRequestPayload
): Promise<"approved" | "blocked"> {
  if (
    workspaceWindow.isDestroyed() ||
    workspaceWindow.webContents.isDestroyed()
  ) {
    return Promise.resolve("approved");
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const requestId = createWorkspaceWindowQuitCloseRequestId();
    const finish = (outcome: "approved" | "blocked") => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      ipcMain.removeListener(
        desktopIpcChannels.host.window.closeRequestResolved,
        handleResolution
      );
      resolve(outcome);
    };
    const handleResolution = (
      event: Electron.IpcMainEvent,
      resolution?: DesktopHostWindowCloseRequestResolutionPayload
    ) => {
      if (
        event.sender !== workspaceWindow.webContents ||
        resolution?.requestId !== requestId
      ) {
        return;
      }

      finish(resolution.outcome === "approved" ? "approved" : "blocked");
    };

    workspaceWindow.once("closed", () => finish("approved"));
    ipcMain.on(
      desktopIpcChannels.host.window.closeRequestResolved,
      handleResolution
    );
    timeout = setTimeout(() => {
      if (payload.reason !== "quit" && !workspaceWindow.isDestroyed()) {
        workspaceWindow.destroy();
      }
      finish(payload.reason === "quit" ? "blocked" : "approved");
    }, workspaceWindowQuitCloseTimeoutMs);
    sendWorkspaceWindowCloseRequest(workspaceWindow, {
      ...payload,
      requestId
    });
  });
}

function sendWorkspaceWindowCloseRequest(
  workspaceWindow: BrowserWindow,
  payload: DesktopHostWindowCloseRequestPayload
): void {
  if (
    workspaceWindow.isDestroyed() ||
    workspaceWindow.webContents.isDestroyed()
  ) {
    return;
  }

  workspaceWindow.webContents.send(
    desktopIpcChannels.host.window.closeRequest,
    payload
  );
}

function createWorkspaceWindowQuitCloseRequestId(): string {
  workspaceWindowQuitCloseRequestSequence += 1;
  return `workspace-window-close-${workspaceWindowQuitCloseRequestSequence}`;
}

function isWorkspaceAppSessionPartition(
  partition: string | undefined
): partition is string {
  return (partition ?? "").startsWith(workspaceAppBrowserPartitionPrefix);
}
