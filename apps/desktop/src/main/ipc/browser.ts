import {
  app,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  webContents
} from "electron";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserSessionPartition } from "@tutti-os/browser-node";
import { registerBrowserNodeElectronMain } from "@tutti-os/browser-node/electron-main";
import type { BrowserNodeElectronLogger } from "@tutti-os/browser-node/electron-main";
import {
  desktopIpcChannels,
  type DesktopInvokeChannel
} from "../../shared/contracts/ipc.ts";
import { isDesktopDevelopmentRuntime } from "../../shared/runtimeEnvironment.ts";
import {
  getBrowserGuestWebContentsIdsForWindow,
  isBrowserGuestWebContentsAttachedToWindow
} from "../browser/browserGuestRegistry.ts";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences.ts";
import { getDesktopLogger } from "../logging.ts";
import { registerDesktopIpcHandler } from "./handle.ts";
import {
  resolveDesktopBrowserPreferredColorScheme,
  type BrowserPreferredColorScheme
} from "./browserPreferredColorScheme.ts";
import { resolveOwnerWindowFromEvent } from "./ownerWindow.ts";
import { openFileWithDefaultBrowser } from "../host/openWithApplications.ts";

type BrowserInvokeChannel = Exclude<
  (typeof desktopIpcChannels.browser)[keyof typeof desktopIpcChannels.browser],
  typeof desktopIpcChannels.browser.event
>;

const prefersColorSchemeFeatureName = "prefers-color-scheme";
const maximumCookieImportBytes = 10 * 1024 * 1024;

function getPreferredColorScheme(
  preferences: DesktopHostPreferencesState
): BrowserPreferredColorScheme {
  return resolveDesktopBrowserPreferredColorScheme({
    nativeShouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    themeSource: preferences.getThemeSource()
  });
}

export function registerBrowserIpc(
  preferences: DesktopHostPreferencesState
): void {
  const logger = getDesktopLogger();
  const preparedDownloadSessions = new WeakSet<Electron.Session>();

  registerBrowserNodeElectronMain({
    channels: {
      ...desktopIpcChannels.browser,
      openDevTools: isBrowserDevToolsEnabled()
        ? desktopIpcChannels.browser.openDevTools
        : undefined,
      showDevToolsContextMenu: isBrowserDevToolsEnabled()
        ? desktopIpcChannels.browser.showDevToolsContextMenu
        : undefined
    },
    async chooseDownloadDirectory(ownerWindow) {
      const result = await dialog.showOpenDialog(ownerWindow, {
        properties: ["openDirectory", "createDirectory"]
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    getOwnerWindow(event) {
      return resolveOwnerWindowFromEvent(event as Electron.IpcMainInvokeEvent);
    },
    getPreferredColorScheme: () => getPreferredColorScheme(preferences),
    logger,
    openDownloadedFile: async (path) => {
      const error = await shell.openPath(path);
      if (error) {
        throw new Error(error);
      }
    },
    openExternal: (url) => openBrowserNodeExternalUrl(url, logger),
    prepareSession(payload) {
      const browserSession = session.fromPartition(
        resolveBrowserSessionPartition(payload)
      );
      if (!preparedDownloadSessions.has(browserSession)) {
        browserSession.setDownloadPath(app.getPath("downloads"));
        preparedDownloadSessions.add(browserSession);
      }
    },
    registerHandler(channel, handler) {
      registerDesktopIpcHandler(
        channel as BrowserInvokeChannel & DesktopInvokeChannel,
        (event, payload) =>
          Promise.resolve(handler(event, payload as never)) as Promise<never>
      );
    },
    registerListener(channel, handler) {
      ipcMain.on(channel, (event, payload) => {
        if (channel === desktopIpcChannels.browser.guestOpenUrl) {
          logger.info("Browser Node guest open-url IPC received", {
            payload: normalizeBrowserGuestDiagnosticPayload(payload),
            webContentsId: event.sender.id
          });
        }
        handler(event, payload as never);
      });
    },
    resolveWebContents({ ownerWindow, webContentsId }) {
      if (
        !isBrowserGuestWebContentsAttachedToWindow(ownerWindow, webContentsId)
      ) {
        logRejectedGuest(logger, ownerWindow, webContentsId);
        return null;
      }

      const resolved = webContents.fromId(webContentsId) ?? null;
      logger.debug?.("Browser Node resolved guest webContents", {
        ownerWindowId: ownerWindow.id,
        webContentsId,
        webContentsResolved: resolved !== null
      });
      return resolved;
    },
    async saveScreenshot({ dataUrl, ownerWindow, suggestedFileName }) {
      const result = await dialog.showSaveDialog(ownerWindow, {
        defaultPath: join(app.getPath("downloads"), suggestedFileName),
        filters: [{ extensions: ["png"], name: "PNG" }]
      });
      if (result.canceled || !result.filePath) {
        return { filePath: null, saved: false };
      }
      const encodedImage = dataUrl.match(/^data:image\/png;base64,(.+)$/)?.[1];
      if (!encodedImage) {
        throw new Error("Browser screenshot did not contain PNG data");
      }
      await writeFile(result.filePath, Buffer.from(encodedImage, "base64"));
      return { filePath: result.filePath, saved: true };
    },
    async selectCookieImport(ownerWindow) {
      const result = await dialog.showOpenDialog(ownerWindow, {
        properties: ["openFile"]
      });
      const filePath = result.canceled ? null : (result.filePaths[0] ?? null);
      if (!filePath) {
        return null;
      }
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > maximumCookieImportBytes) {
        throw new Error("Browser Cookie import file is invalid or too large");
      }
      return {
        contents: await readFile(filePath, "utf8"),
        fileName: filePath.split(/[\\/]/).at(-1) ?? "cookies"
      };
    },
    showDownloadedFile: (path) => shell.showItemInFolder(path),
    async syncPreferredColorScheme(contents, scheme) {
      const guestContents = contents as Electron.WebContents;
      const wasAttached = guestContents.debugger.isAttached();
      if (!wasAttached) {
        guestContents.debugger.attach();
      }

      try {
        await guestContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [
            {
              name: prefersColorSchemeFeatureName,
              value: scheme
            }
          ]
        });
      } finally {
        if (!wasAttached && guestContents.debugger.isAttached()) {
          guestContents.debugger.detach();
        }
      }
    },
    subscribePreferredColorScheme(listener) {
      let previousScheme = getPreferredColorScheme(preferences);
      const handleThemeUpdate = () => {
        const nextScheme = getPreferredColorScheme(preferences);
        if (nextScheme === previousScheme) {
          return;
        }

        previousScheme = nextScheme;
        listener(nextScheme);
      };

      nativeTheme.on("updated", handleThemeUpdate);
      const unsubscribePreferences = preferences.subscribe(handleThemeUpdate);
      return () => {
        nativeTheme.off("updated", handleThemeUpdate);
        unsubscribePreferences();
      };
    }
  });

  ipcMain.on(desktopIpcChannels.browser.guestDiagnostic, (event, payload) => {
    logger.info("Browser Node guest preload diagnostic", {
      payload: normalizeBrowserGuestDiagnosticPayload(payload),
      webContentsId: event.sender.id
    });
  });
}

function isBrowserDevToolsEnabled(): boolean {
  return isDesktopDevelopmentRuntime({
    tuttiEnv: process.env.TUTTI_ENV,
    nodeEnv: process.env.NODE_ENV
  });
}

async function openBrowserNodeExternalUrl(
  url: string,
  logger: BrowserNodeElectronLogger
): Promise<void> {
  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    throw new Error("Browser Node rejected empty external URL");
  }

  if (trimmedUrl.startsWith("file://")) {
    let filePath: string;
    try {
      filePath = fileURLToPath(trimmedUrl);
    } catch (error) {
      throw new Error("Browser Node rejected external file URL", {
        cause: error
      });
    }

    if (process.platform === "darwin") {
      try {
        await openFileWithDefaultBrowser(filePath);
        return;
      } catch (error) {
        logger.warn?.("Browser Node openFileWithDefaultBrowser failed", {
          error: error instanceof Error ? error.message : String(error),
          filePath,
          url: trimmedUrl
        });
      }
    }

    const openPathError = await shell.openPath(filePath);
    if (openPathError.length === 0) {
      return;
    }

    logger.warn?.("Browser Node shell.openPath failed", {
      error: openPathError,
      filePath,
      url: trimmedUrl
    });
  }

  await shell.openExternal(trimmedUrl);
}

function logRejectedGuest(
  logger: BrowserNodeElectronLogger,
  ownerWindow: Electron.BrowserWindow,
  webContentsId: number
): void {
  logger.warn?.("Browser Node rejected unknown guest webContents", {
    attachedGuestIds: getBrowserGuestWebContentsIdsForWindow(ownerWindow),
    ownerWindowId: ownerWindow.id,
    webContentsId
  });
}

function normalizeBrowserGuestDiagnosticPayload(
  payload: unknown
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      normalized[key] = value;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      normalized[key] = { ...value };
    }
  }
  return normalized;
}
