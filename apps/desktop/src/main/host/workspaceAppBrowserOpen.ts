import {
  resolveBrowserNavigationUrl,
  type BrowserNodeOpenUrlEvent
} from "@tutti-os/browser-node";
import {
  desktopIpcChannels,
  type DesktopWorkspaceAppPopupRejectedEvent
} from "../../shared/contracts/ipc.ts";

export interface WorkspaceAppBrowserOpenContents {
  id: number;
}

export interface WorkspaceAppBrowserOpenOwnerWindow {
  isDestroyed?(): boolean;
  webContents: {
    isDestroyed?(): boolean;
    send(
      channel: string,
      payload: BrowserNodeOpenUrlEvent | DesktopWorkspaceAppPopupRejectedEvent
    ): void;
  };
}

export interface WorkspaceAppBrowserOpenLogger {
  debug?(message: string, details?: Record<string, unknown>): void;
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
}

export function dispatchWorkspaceAppOpenUrl(input: {
  contents: WorkspaceAppBrowserOpenContents;
  logger?: WorkspaceAppBrowserOpenLogger;
  ownerWindow: WorkspaceAppBrowserOpenOwnerWindow;
  producer: "external-browser-api" | "window-open-handler";
  url: string;
}): boolean {
  const { contents, logger, ownerWindow, producer, url } = input;
  const resolved = resolveBrowserNavigationUrl(url);
  if (!resolved.url) {
    logger?.warn?.("workspace app guest ignored unsupported open-url", {
      url,
      webContentsId: contents.id
    });
    return false;
  }

  if (
    ownerWindow.isDestroyed?.() === true ||
    ownerWindow.webContents.isDestroyed?.() === true
  ) {
    logger?.warn?.("workspace app guest open-url owner window unavailable", {
      ownerWindowDestroyed: ownerWindow.isDestroyed?.() === true,
      ownerWebContentsDestroyed:
        ownerWindow.webContents.isDestroyed?.() === true,
      url: resolved.url,
      webContentsId: contents.id
    });
    return false;
  }

  const payload: BrowserNodeOpenUrlEvent = {
    reuseIfOpen: false,
    sourceNodeId: `workspace-app:${contents.id}`,
    type: "open-url",
    url: resolved.url
  };
  logger?.info?.("workspace app emitted open-url", {
    producer,
    sourceNodeId: payload.sourceNodeId,
    url: payload.url,
    webContentsId: contents.id
  });
  ownerWindow.webContents.send(desktopIpcChannels.browser.event, payload);
  return true;
}
