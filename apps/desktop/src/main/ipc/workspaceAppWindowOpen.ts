import {
  resolveBrowserNavigationUrl,
  type BrowserNodeOpenUrlEvent
} from "@tutti-os/browser-node";
import { normalizeTuttiExternalBrowserOpenUrlInput } from "@tutti-os/workspace-external-core/core";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";

interface WorkspaceAppWindowOpenContents {
  id: number;
  setWindowOpenHandler?(
    handler: (details: { url: string }) => { action: "allow" | "deny" }
  ): void;
}

interface WorkspaceAppWindowOpenOwnerWindow {
  isDestroyed?(): boolean;
  webContents: {
    isDestroyed?(): boolean;
    send(channel: string, payload: BrowserNodeOpenUrlEvent): void;
  };
}

interface WorkspaceAppWindowOpenLogger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
}

interface WorkspaceAppWindowOpenHandlerInput {
  contents: WorkspaceAppWindowOpenContents;
  logger?: WorkspaceAppWindowOpenLogger;
  ownerWindow: WorkspaceAppWindowOpenOwnerWindow;
}

interface WorkspaceAppOpenUrlInput extends WorkspaceAppWindowOpenHandlerInput {
  url: string;
}

interface WorkspaceAppExternalOpenUrlInput extends WorkspaceAppWindowOpenHandlerInput {
  payload: unknown;
}

export function installWorkspaceAppWindowOpenHandler({
  contents,
  logger,
  ownerWindow
}: WorkspaceAppWindowOpenHandlerInput): void {
  const hasSetWindowOpenHandler =
    typeof contents.setWindowOpenHandler === "function";
  if (!hasSetWindowOpenHandler) {
    logger?.warn?.("workspace app guest window-open handler unavailable", {
      webContentsId: contents.id
    });
    return;
  }

  contents.setWindowOpenHandler?.(({ url }) => {
    dispatchWorkspaceAppOpenUrl({ contents, logger, ownerWindow, url });
    return { action: "deny" };
  });
}

export function dispatchWorkspaceAppOpenUrl({
  contents,
  logger,
  ownerWindow,
  url
}: WorkspaceAppOpenUrlInput): boolean {
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
    sourceNodeId: payload.sourceNodeId,
    url: payload.url,
    webContentsId: contents.id
  });
  ownerWindow.webContents.send(desktopIpcChannels.browser.event, payload);
  return true;
}

/**
 * Dispatches the JSB browser.openUrl notification after validating it again in
 * the privileged main process. Native window-open/link handling intentionally
 * continues through dispatchWorkspaceAppOpenUrl and keeps its existing URL
 * resolution semantics.
 */
export function dispatchWorkspaceAppExternalOpenUrl({
  contents,
  logger,
  ownerWindow,
  payload
}: WorkspaceAppExternalOpenUrlInput): boolean {
  try {
    const input = normalizeTuttiExternalBrowserOpenUrlInput(payload);
    return dispatchWorkspaceAppOpenUrl({
      contents,
      logger,
      ownerWindow,
      url: input.url
    });
  } catch {
    logger?.warn?.("workspace app guest ignored invalid JSB open-url", {
      webContentsId: contents.id
    });
    return false;
  }
}
