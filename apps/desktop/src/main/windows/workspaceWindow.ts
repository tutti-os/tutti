import { pathToFileURL } from "node:url";
import { BrowserWindow, app, screen, session, shell } from "electron";
import {
  installBrowserWebviewSecurity,
  isBrowserNodeWebviewAttach
} from "@tutti-os/browser-node/electron-main";
import { registerBrowserGuestWebContents } from "../browser/browserGuestRegistry";
import { registerTuttiAssetProtocolForSession } from "../host/tuttiAssetProtocol.ts";
import { registerWorkspaceAppGuestWebContents } from "../ipc/workspaceAppContext";
import { resolveDesktopWindowBackgroundColor } from "../desktopTheme";
import { getDesktopLogger, type DesktopLogger } from "../logging";
import type { DesktopLocale } from "../../shared/i18n";
import type { DesktopDockPlacement } from "../../shared/preferences/index.ts";
import type { DesktopThemeState } from "../../shared/theme/index.ts";
import {
  applyDesktopWindowIntent,
  createAgentWindowIntent,
  createFusionDockWindowIntent,
  createFusionToolWindowIntent,
  createWorkspaceWindowIntent,
  encodeDesktopWindowIntent
} from "../../shared/contracts/windowIntent";
import type { DesktopFusionWindowKind } from "../../shared/contracts/fusion.ts";
import {
  desktopIpcChannels,
  type DesktopHostWindowCloseRequestPayload
} from "../../shared/contracts/ipc";
import { installWorkspaceWindowDevelopmentReloadShortcut } from "./workspaceWindowReload.ts";
import { resolvePackagedWorkspaceRendererIndexPath } from "./workspaceWindowPaths.ts";
import { resolveCenteredWindowBounds } from "./workspaceWindowBounds.ts";
import {
  isWorkspaceAppSessionPartitionAllowed,
  workspaceAppBrowserPartitionPrefix
} from "../workspaceAppPartition.ts";
import {
  installDesktopRendererNavigationPolicy,
  type DesktopRendererNavigationPolicy
} from "./desktopRendererNavigationPolicy.ts";

export { workspaceAppBrowserPartitionPrefix } from "../workspaceAppPartition.ts";

export interface CreateWorkspaceWindowOptions {
  browserNodeGuestPreloadPath?: string;
  closeFromCommandShortcutNatively?: boolean;
  enableDevelopmentReloadShortcut?: boolean;
  locale: DesktopLocale;
  preloadPath: string;
  rendererUrl?: string;
  theme: DesktopThemeState;
  windowChrome?: "native" | "renderer";
  windowKind?: "agent" | "fusion-tool" | "workspace";
  workspaceAppPreloadPath?: string;
  workspaceID: string;
}

const workspaceWindows = new Set<BrowserWindow>();
const nativeCommandCloseWindows = new WeakSet<BrowserWindow>();
const commandCloseHandlers = new WeakMap<BrowserWindow, () => void>();
const rendererNavigationPolicies = new WeakMap<
  BrowserWindow,
  DesktopRendererNavigationPolicy
>();
const workspaceWindowHeaderHeightPx = 52;
const workspaceWindowMacTrafficLightInsetPx = 16;
const workspaceWindowMacTrafficLightSizePx = 12;
const workspaceWindowMacTrafficLightPositionY =
  (workspaceWindowHeaderHeightPx - workspaceWindowMacTrafficLightSizePx) / 2;
const agentWindowDefaultWidthPx = 1340;
const agentWindowDefaultHeightPx = 830;
const agentWindowMinWidthPx = 760;
const agentWindowMinHeightPx = 520;
const agentWindowWorkAreaMarginPx = 48;

export function createWorkspaceWindow(
  options: CreateWorkspaceWindowOptions
): BrowserWindow {
  const logger = getDesktopLogger();
  const windowKind = options.windowKind ?? "workspace";
  const isStandaloneWindow =
    windowKind === "agent" || windowKind === "fusion-tool";
  const usesNativeWindowChrome =
    isStandaloneWindow && options.windowChrome === "native";
  const usesRendererWindowChrome =
    isStandaloneWindow && !usesNativeWindowChrome;
  const agentWindowBounds =
    windowKind === "agent" && usesRendererWindowChrome
      ? resolveCenteredWindowBounds({
          defaultHeight: agentWindowDefaultHeightPx,
          defaultWidth: agentWindowDefaultWidthPx,
          margin: agentWindowWorkAreaMarginPx,
          minHeight: agentWindowMinHeightPx,
          minWidth: agentWindowMinWidthPx,
          workArea: screen.getPrimaryDisplay().workArea
        })
      : null;
  const workspaceWindow = new BrowserWindow({
    backgroundColor: resolveDesktopWindowBackgroundColor(),
    ...(isStandaloneWindow ? { frame: usesNativeWindowChrome } : {}),
    ...(windowKind === "agent" && usesRendererWindowChrome
      ? { maximizable: false }
      : {}),
    width:
      agentWindowBounds?.width ??
      (windowKind === "agent" ? agentWindowDefaultWidthPx : 1280),
    height:
      agentWindowBounds?.height ??
      (windowKind === "agent" ? agentWindowDefaultHeightPx : 840),
    minWidth: windowKind === "agent" ? agentWindowMinWidthPx : 960,
    minHeight: windowKind === "agent" ? agentWindowMinHeightPx : 640,
    ...(agentWindowBounds
      ? {
          x: agentWindowBounds.x,
          y: agentWindowBounds.y
        }
      : {}),
    show: false,
    ...(process.platform === "darwin"
      ? windowKind === "workspace"
        ? {
            titleBarStyle: "hidden" as const,
            trafficLightPosition: {
              x: workspaceWindowMacTrafficLightInsetPx,
              y: workspaceWindowMacTrafficLightPositionY
            }
          }
        : usesNativeWindowChrome
          ? { titleBarStyle: "default" as const }
          : {}
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: options.preloadPath,
      sandbox: false,
      webviewTag: true
    }
  });
  installDesktopRendererWindowNavigationPolicy(workspaceWindow, logger);

  installBrowserWebviewSecurity({
    allowedSessionPartitions: {
      additionalAllowedPrefixes: [workspaceAppBrowserPartitionPrefix]
    },
    contents: workspaceWindow.webContents,
    logger,
    onGuestAttached: (guestContents, attach) => {
      registerBrowserGuestWebContents(workspaceWindow, guestContents, logger);
      const workspaceAppPartition = attach.params.partition;
      if (
        workspaceAppPartition?.startsWith(workspaceAppBrowserPartitionPrefix)
      ) {
        registerWorkspaceAppGuestWebContents(
          workspaceWindow,
          guestContents,
          options.workspaceID,
          logger,
          workspaceAppPartition
        );
      }
    },
    openExternal: (url) => shell.openExternal(url),
    resolveSessionIdentity: (partition) => session.fromPartition(partition),
    validateWebviewAttach(params) {
      const partition = params.partition;
      return (
        !partition?.trim().startsWith(workspaceAppBrowserPartitionPrefix) ||
        isWorkspaceAppSessionPartitionAllowed(partition, options.workspaceID)
      );
    },
    resolvePreload({ params }) {
      const workspaceAppPartition = params.partition;
      if (
        options.workspaceAppPreloadPath &&
        typeof workspaceAppPartition === "string" &&
        isWorkspaceAppSessionPartitionAllowed(
          workspaceAppPartition,
          options.workspaceID
        )
      ) {
        registerTuttiAssetProtocolForSession(
          session.fromPartition(workspaceAppPartition)
        );
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
        !params.partition?.trim().startsWith(workspaceAppBrowserPartitionPrefix)
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
  if (options.closeFromCommandShortcutNatively === true) {
    nativeCommandCloseWindows.add(workspaceWindow);
  }
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
        compactTitlebar: workspaceWindow.isFullScreen(),
        maximized:
          workspaceWindow.isMaximized() || workspaceWindow.isFullScreen()
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

export function installDesktopRendererWindowNavigationPolicy(
  window: BrowserWindow,
  logger: DesktopLogger = getDesktopLogger()
): void {
  if (rendererNavigationPolicies.has(window)) {
    return;
  }
  const policy = installDesktopRendererNavigationPolicy({
    contents: window.webContents,
    logger,
    openExternal: (url) => shell.openExternal(url)
  });
  rendererNavigationPolicies.set(window, policy);
  window.once("closed", () => {
    policy.dispose();
    rendererNavigationPolicies.delete(window);
  });
}

export function loadAgentWindowContent(
  agentWindow: BrowserWindow,
  options: Pick<
    CreateWorkspaceWindowOptions,
    "locale" | "rendererUrl" | "workspaceID"
  > & {
    dockPlacement: DesktopDockPlacement;
    launchPayload?: unknown;
    resourceID?: string | null;
    theme: DesktopThemeState;
    windowInstanceID?: string | null;
  }
): void {
  const windowIntentSearchOptions = {
    dockPlacement: options.dockPlacement,
    locale: options.locale,
    themeAppearance: options.theme.appearance,
    themeSource: options.theme.source
  };
  const intent = createAgentWindowIntent({
    launchPayload: options.launchPayload,
    resourceID: options.resourceID,
    windowInstanceID: options.windowInstanceID,
    workspaceID: options.workspaceID
  });
  if (options.rendererUrl) {
    loadAuthorizedDesktopRendererUrl(
      agentWindow,
      applyDesktopWindowIntent(
        options.rendererUrl,
        intent,
        windowIntentSearchOptions
      )
    );
    return;
  }

  loadAuthorizedDesktopRendererFile(
    agentWindow,
    resolvePackagedWorkspaceRendererIndexPath(app.getAppPath()),
    encodeDesktopWindowIntent(intent, windowIntentSearchOptions)
  );
}

export function loadFusionDockWindowContent(
  dockWindow: BrowserWindow,
  options: Pick<
    CreateWorkspaceWindowOptions,
    "locale" | "rendererUrl" | "workspaceID"
  > & {
    dockPlacement: DesktopDockPlacement;
    theme: DesktopThemeState;
  }
): void {
  loadWindowIntentContent(
    dockWindow,
    createFusionDockWindowIntent(options.workspaceID),
    options
  );
}

export function loadFusionToolWindowContent(
  toolWindow: BrowserWindow,
  options: Pick<
    CreateWorkspaceWindowOptions,
    "locale" | "rendererUrl" | "workspaceID"
  > & {
    dockPlacement: DesktopDockPlacement;
    fusionWindowKind: DesktopFusionWindowKind;
    launchPayload?: unknown;
    resourceID?: string | null;
    theme: DesktopThemeState;
    windowInstanceID: string;
  }
): void {
  loadWindowIntentContent(
    toolWindow,
    createFusionToolWindowIntent({
      fusionWindowKind: options.fusionWindowKind,
      launchPayload: options.launchPayload,
      resourceID: options.resourceID,
      windowInstanceID: options.windowInstanceID,
      workspaceID: options.workspaceID
    }),
    options
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
    themeAppearance: options.theme.appearance,
    themeSource: options.theme.source
  };
  if (options.rendererUrl) {
    loadAuthorizedDesktopRendererUrl(
      workspaceWindow,
      applyDesktopWindowIntent(
        options.rendererUrl,
        createWorkspaceWindowIntent(options.workspaceID),
        windowIntentSearchOptions
      )
    );
    return;
  }

  loadAuthorizedDesktopRendererFile(
    workspaceWindow,
    resolvePackagedWorkspaceRendererIndexPath(app.getAppPath()),
    encodeDesktopWindowIntent(
      createWorkspaceWindowIntent(options.workspaceID),
      windowIntentSearchOptions
    )
  );
}

function loadWindowIntentContent(
  window: BrowserWindow,
  intent: Parameters<typeof applyDesktopWindowIntent>[1],
  options: Pick<CreateWorkspaceWindowOptions, "locale" | "rendererUrl"> & {
    dockPlacement: DesktopDockPlacement;
    theme: DesktopThemeState;
  }
): void {
  const searchOptions = {
    dockPlacement: options.dockPlacement,
    locale: options.locale,
    themeAppearance: options.theme.appearance,
    themeSource: options.theme.source
  };
  if (options.rendererUrl) {
    loadAuthorizedDesktopRendererUrl(
      window,
      applyDesktopWindowIntent(options.rendererUrl, intent, searchOptions)
    );
    return;
  }
  loadAuthorizedDesktopRendererFile(
    window,
    resolvePackagedWorkspaceRendererIndexPath(app.getAppPath()),
    encodeDesktopWindowIntent(intent, searchOptions)
  );
}

function loadAuthorizedDesktopRendererUrl(
  window: BrowserWindow,
  url: string
): void {
  requireRendererNavigationPolicy(window).authorize(url);
  void window.loadURL(url);
}

function loadAuthorizedDesktopRendererFile(
  window: BrowserWindow,
  path: string,
  search: string
): void {
  const url = pathToFileURL(path);
  url.search = search;
  requireRendererNavigationPolicy(window).authorize(url.href);
  void window.loadFile(path, { search });
}

function requireRendererNavigationPolicy(
  window: BrowserWindow
): DesktopRendererNavigationPolicy {
  const policy = rendererNavigationPolicies.get(window);
  if (!policy) {
    throw new Error("Desktop renderer navigation policy is unavailable");
  }
  return policy;
}

export function requestWorkspaceWindowCloseFromCommandShortcut(
  workspaceWindow: BrowserWindow
): void {
  const handler = commandCloseHandlers.get(workspaceWindow);
  if (handler) {
    handler();
    return;
  }
  if (nativeCommandCloseWindows.has(workspaceWindow)) {
    workspaceWindow.close();
    return;
  }
  sendWorkspaceWindowCloseRequest(workspaceWindow, { reason: "window-close" });
}

export function registerWorkspaceWindowCommandCloseHandler(
  workspaceWindow: BrowserWindow,
  handler: () => void
): () => void {
  commandCloseHandlers.set(workspaceWindow, handler);
  return () => {
    if (commandCloseHandlers.get(workspaceWindow) === handler) {
      commandCloseHandlers.delete(workspaceWindow);
    }
  };
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
