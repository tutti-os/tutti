import { BrowserWindow, app, screen, session, shell } from "electron";
import type { DesktopAgentDirectorySnapshot } from "../../shared/contracts/agentDirectory.ts";
import type { DesktopAgentProviderStatusSnapshot } from "../../shared/contracts/ipc";
import { AGENT_GUI_COLLAPSED_MIN_WIDTH_PX } from "@tutti-os/agent-gui/layout";
import {
  installBrowserWebviewSecurity,
  isBrowserNodeWebviewAttach
} from "@tutti-os/browser-node/electron-main";
import { registerBrowserGuestWebContents } from "../browser/browserGuestRegistry";
import { registerTuttiAssetProtocolForSession } from "../host/tuttiAssetProtocol.ts";
import { registerWorkspaceAppGuestWebContents } from "../ipc/workspaceAppContext";
import { resolveDesktopWindowBackgroundColor } from "../desktopTheme";
import { resolveDesktopPerformanceHeadless } from "../defaults.ts";
import { getDesktopLogger } from "../logging";
import type { DesktopLocale } from "../../shared/i18n";
import type { DesktopDockPlacement } from "../../shared/preferences/index.ts";
import type { DesktopThemeState } from "../../shared/theme/index.ts";
import {
  applyDesktopWindowIntent,
  createAgentWindowIntent,
  createWorkspaceWindowIntent,
  encodeDesktopWindowIntent
} from "../../shared/contracts/windowIntent";
import {
  desktopIpcChannels,
  type DesktopHostWindowCloseRequestPayload
} from "../../shared/contracts/ipc";
import { installWorkspaceWindowDevelopmentReloadShortcut } from "./workspaceWindowReload.ts";
import { resolvePackagedWorkspaceRendererIndexPath } from "./workspaceWindowPaths.ts";
import { createPrimaryWindowAnalyticsClaim } from "./primaryWindowAnalyticsClaim.ts";
import {
  resolveStandaloneAgentWindowBounds,
  resolveStandaloneAgentWindowOffsetBounds,
  resolveStandaloneAgentWindowWorkArea
} from "./standaloneAgentWindowBounds.ts";
import { WorkspaceWindowRegistry } from "./workspaceWindowRegistry.ts";

export const workspaceAppBrowserPartitionPrefix = "persist:tutti-app:";

export interface CreateWorkspaceWindowOptions {
  browserNodeGuestPreloadPath?: string;
  enableDevelopmentReloadShortcut?: boolean;
  locale: DesktopLocale;
  preloadPath: string;
  rendererUrl?: string;
  theme: DesktopThemeState;
  openerBounds?: Electron.Rectangle | null;
  openerWindowKind?: "agent" | "workspace" | null;
  offsetFromSourceWindow?: boolean;
  windowKind?: "agent" | "workspace";
  workspaceAppPreloadPath?: string;
  workspaceID: string;
}

const workspaceWindows = new WorkspaceWindowRegistry<BrowserWindow>();
// DAU/PV belongs to the first workspace renderer for the lifetime of this main
// process. Do not derive this from current registry membership: closing the
// owner must not let a later window report another process-level open/pageview.
const primaryWindowAnalyticsClaim = createPrimaryWindowAnalyticsClaim();
const reportPredefinePageviewByWindow = new WeakMap<BrowserWindow, boolean>();
const workspaceWindowHeaderHeightPx = 52;
const workspaceWindowMacTrafficLightInsetPx = 16;
const workspaceWindowMacTrafficLightSizePx = 12;
const workspaceWindowMacTrafficLightPositionY =
  (workspaceWindowHeaderHeightPx - workspaceWindowMacTrafficLightSizePx) / 2;
const workspaceWindowDockHeightPx = 64;
const agentWindowMinWidthPx = AGENT_GUI_COLLAPSED_MIN_WIDTH_PX;
const agentWindowMinHeightPx = 520;
const agentWindowWorkAreaScale = 0.9;
const agentWindowDuplicateOffsetPx = 25;
const linuxWindowResizeSettleDelayMs = 150;

function sendWorkspaceWindowLayout(workspaceWindow: BrowserWindow): void {
  if (
    workspaceWindow.isDestroyed() ||
    workspaceWindow.webContents.isDestroyed()
  ) {
    return;
  }

  workspaceWindow.webContents.send(desktopIpcChannels.host.window.layout, {
    compactTitlebar: workspaceWindow.isFullScreen(),
    maximized: workspaceWindow.isMaximized() || workspaceWindow.isFullScreen()
  });
}

export function createWorkspaceWindow(
  options: CreateWorkspaceWindowOptions
): BrowserWindow {
  const logger = getDesktopLogger();
  const performanceHeadless = resolveDesktopPerformanceHeadless();
  const windowKind = options.windowKind ?? "workspace";
  if (windowKind === "workspace") {
    workspaceWindows.assertDurableWorkspaceAvailable(options.workspaceID);
  }
  const agentDisplay = options.openerBounds
    ? screen.getDisplayMatching(options.openerBounds)
    : screen.getPrimaryDisplay();
  const defaultAgentWindowBounds =
    windowKind === "agent"
      ? resolveStandaloneAgentWindowBounds({
          scale: agentWindowWorkAreaScale,
          minHeight: agentWindowMinHeightPx,
          minWidth: agentWindowMinWidthPx,
          workArea: resolveStandaloneAgentWindowWorkArea({
            bottomInset: workspaceWindowDockHeightPx,
            fallbackWorkArea: agentDisplay.workArea,
            openerBounds:
              options.openerWindowKind === "workspace"
                ? options.openerBounds
                : null,
            topInset: workspaceWindowHeaderHeightPx
          })
        })
      : null;
  const agentWindowBounds =
    defaultAgentWindowBounds &&
    options.offsetFromSourceWindow === true &&
    options.openerBounds
      ? resolveStandaloneAgentWindowOffsetBounds({
          offset: agentWindowDuplicateOffsetPx,
          sourceBounds: options.openerBounds,
          targetBounds: defaultAgentWindowBounds,
          workArea: agentDisplay.workArea
        })
      : defaultAgentWindowBounds;
  const workspaceWindow = new BrowserWindow({
    backgroundColor: resolveDesktopWindowBackgroundColor(),
    frame: windowKind === "agent" ? false : undefined,
    // The agent window's green control is a native fullscreen toggle, and its
    // frameless chrome draws custom traffic lights. Disabling native zoom stops
    // macOS double-click-title-bar from zooming into an ambiguous "maximized"
    // state that the custom restore icon can't reliably track.
    ...(windowKind === "agent" ? { maximizable: false } : {}),
    width: agentWindowBounds?.width ?? 1280,
    height: agentWindowBounds?.height ?? 840,
    minWidth: windowKind === "agent" ? agentWindowMinWidthPx : 960,
    minHeight: windowKind === "agent" ? agentWindowMinHeightPx : 640,
    ...(performanceHeadless ? { opacity: 0, skipTaskbar: true } : {}),
    ...(agentWindowBounds
      ? {
          x: agentWindowBounds.x,
          y: agentWindowBounds.y
        }
      : {}),
    show: false,
    ...(process.platform === "darwin" && windowKind === "workspace"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: {
            x: workspaceWindowMacTrafficLightInsetPx,
            y: workspaceWindowMacTrafficLightPositionY
          }
        }
      : {}),
    webPreferences: {
      backgroundThrottling: !performanceHeadless,
      contextIsolation: true,
      nodeIntegration: false,
      preload: options.preloadPath,
      sandbox: false,
      webviewTag: true
    }
  });
  if (performanceHeadless) {
    workspaceWindow.setFocusable(false);
    workspaceWindow.setIgnoreMouseEvents(true);
  }
  reportPredefinePageviewByWindow.set(
    workspaceWindow,
    primaryWindowAnalyticsClaim.claim()
  );

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
  workspaceWindows.register(workspaceWindow, {
    kind: windowKind,
    workspaceID: options.workspaceID
  });
  workspaceWindow.once("closed", () => {
    workspaceWindows.unregister(workspaceWindow);
  });

  const sendHostWindowLayout = () => {
    sendWorkspaceWindowLayout(workspaceWindow);
  };
  workspaceWindow.on("maximize", sendHostWindowLayout);
  workspaceWindow.on("unmaximize", sendHostWindowLayout);
  workspaceWindow.on("enter-full-screen", sendHostWindowLayout);
  workspaceWindow.on("leave-full-screen", sendHostWindowLayout);
  workspaceWindow.webContents.on("did-finish-load", sendHostWindowLayout);

  if (process.platform === "linux") {
    let resizeLayoutTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleHostWindowLayout = () => {
      if (resizeLayoutTimer !== null) {
        clearTimeout(resizeLayoutTimer);
      }

      resizeLayoutTimer = setTimeout(() => {
        resizeLayoutTimer = null;
        sendHostWindowLayout();
      }, linuxWindowResizeSettleDelayMs);
    };

    workspaceWindow.on("resize", scheduleHostWindowLayout);
    workspaceWindow.once("closed", () => {
      if (resizeLayoutTimer !== null) {
        clearTimeout(resizeLayoutTimer);
      }
    });
  } else {
    workspaceWindow.on("resized", sendHostWindowLayout);
  }

  if (process.platform === "darwin") {
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

export function getWorkspaceWindowKind(
  workspaceWindow: BrowserWindow
): "agent" | "workspace" | null {
  return workspaceWindows.getKind(workspaceWindow);
}

export function getWorkspaceWindowWorkspaceID(
  workspaceWindow: BrowserWindow
): string | null {
  return workspaceWindows.getWorkspaceID(workspaceWindow);
}

export function findWorkspaceWindow(
  workspaceID: string,
  kind: "agent" | "workspace"
): BrowserWindow | null {
  return workspaceWindows.findWorkspaceWindow(workspaceID, kind);
}

export function loadAgentWindowContent(
  agentWindow: BrowserWindow,
  options: Pick<
    CreateWorkspaceWindowOptions,
    "locale" | "rendererUrl" | "workspaceID"
  > & {
    agentDirectorySnapshot?: DesktopAgentDirectorySnapshot | null;
    agentSessionID?: string | null;
    agentTargetID?: string | null;
    autoSubmit?: boolean;
    dockPlacement: DesktopDockPlacement;
    draftPrompt?: string | null;
    providerStatusSnapshot?: DesktopAgentProviderStatusSnapshot | null;
    provider?: string | null;
    theme: DesktopThemeState;
    userProjectPath?: string | null;
  }
): void {
  const windowIntentSearchOptions = {
    dockPlacement: options.dockPlacement,
    locale: options.locale,
    reportPredefinePageview:
      reportPredefinePageviewByWindow.get(agentWindow) === true,
    themeAppearance: options.theme.appearance,
    themeSource: options.theme.source
  };
  const intent = createAgentWindowIntent({
    agentDirectorySnapshot: options.agentDirectorySnapshot,
    agentSessionID: options.agentSessionID,
    agentTargetID: options.agentTargetID,
    autoSubmit: options.autoSubmit,
    draftPrompt: options.draftPrompt,
    providerStatusSnapshot: options.providerStatusSnapshot,
    provider: options.provider,
    userProjectPath: options.userProjectPath,
    workspaceID: options.workspaceID
  });
  if (options.rendererUrl) {
    void agentWindow.loadURL(
      applyDesktopWindowIntent(
        options.rendererUrl,
        intent,
        windowIntentSearchOptions
      )
    );
    return;
  }

  void agentWindow.loadFile(
    resolvePackagedWorkspaceRendererIndexPath(app.getAppPath()),
    {
      search: encodeDesktopWindowIntent(intent, windowIntentSearchOptions)
    }
  );
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
    reportPredefinePageview:
      reportPredefinePageviewByWindow.get(workspaceWindow) === true,
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

function isWorkspaceAppSessionPartition(
  partition: string | undefined
): partition is string {
  return (partition ?? "").startsWith(workspaceAppBrowserPartitionPrefix);
}
