import {
  resolveBrowserNavigationUrl,
  type BrowserNodeOpenUrlEvent
} from "@tutti-os/browser-node";
import type { BrowserWebviewWindowOpenHandler } from "@tutti-os/browser-node/electron-main";
import {
  desktopIpcChannels,
  type DesktopWorkspaceAppPopupRejectedEvent
} from "../../shared/contracts/ipc.ts";

interface WorkspaceAppOpenUrlContents {
  id: number;
}

interface WorkspaceAppWindowOpenContents extends WorkspaceAppOpenUrlContents {
  getURL(): string;
  isDestroyed?(): boolean;
  loadURL(url: string): Promise<void>;
}

interface WorkspaceAppWindowOpenOwnerWindow {
  isDestroyed?(): boolean;
  webContents: {
    isDestroyed?(): boolean;
    send(
      channel: string,
      payload: BrowserNodeOpenUrlEvent | DesktopWorkspaceAppPopupRejectedEvent
    ): void;
  };
}

interface WorkspaceAppWindowOpenLogger {
  debug?(message: string, details?: Record<string, unknown>): void;
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
}

interface WorkspaceAppWindowOpenHandlerInput {
  contents: WorkspaceAppWindowOpenContents;
  logger?: WorkspaceAppWindowOpenLogger;
  ownerWindow: WorkspaceAppWindowOpenOwnerWindow;
}

interface WorkspaceAppOpenUrlInput {
  contents: WorkspaceAppOpenUrlContents;
  logger?: WorkspaceAppWindowOpenLogger;
  ownerWindow: WorkspaceAppWindowOpenOwnerWindow;
  producer: "external-browser-api" | "window-open-handler";
  url: string;
}

type WorkspaceAppWindowOpenDecision =
  | { action: "navigate-current"; url: string }
  | { action: "open-browser"; url: string }
  | {
      action: "reject";
      reason:
        | "deferred-navigation-unsupported"
        | "post-unsupported"
        | "unsupported-url";
    };

export function createWorkspaceAppWindowOpenHandler({
  contents,
  logger,
  ownerWindow
}: WorkspaceAppWindowOpenHandlerInput): BrowserWebviewWindowOpenHandler {
  return (details) => {
    logger?.debug?.("workspace app guest window-open callback", {
      hasPostBody: details.postBody !== undefined,
      webContentsId: contents.id
    });
    const decision = decideWorkspaceAppWindowOpen({
      currentUrl: contents.getURL(),
      hasPostBody: details.postBody !== undefined,
      targetUrl: details.url
    });
    if (decision.action === "reject") {
      logWorkspaceAppPopupRejection({
        contents,
        decision,
        details,
        logger
      });
      if (decision.reason !== "unsupported-url") {
        notifyWorkspaceAppPopupRejected(ownerWindow, {
          reason: decision.reason
        });
      }
      return { action: "deny" };
    }
    if (decision.action === "navigate-current") {
      logger?.info?.("workspace app popup navigated current guest", {
        targetUrl: decision.url,
        webContentsId: contents.id
      });
      setImmediate(() => {
        if (contents.isDestroyed?.() === true) {
          return;
        }
        void contents.loadURL(decision.url).catch((error: unknown) => {
          logger?.warn?.("workspace app popup navigation failed", {
            error: error instanceof Error ? error.message : String(error),
            targetUrl: decision.url,
            webContentsId: contents.id
          });
        });
      });
      return { action: "deny" };
    }
    dispatchWorkspaceAppOpenUrl({
      contents,
      logger,
      ownerWindow,
      producer: "window-open-handler",
      url: decision.url
    });
    return { action: "deny" };
  };
}

function decideWorkspaceAppWindowOpen(input: {
  currentUrl: string;
  hasPostBody: boolean;
  targetUrl: string;
}): WorkspaceAppWindowOpenDecision {
  if (input.hasPostBody) {
    return { action: "reject", reason: "post-unsupported" };
  }
  const targetUrl = input.targetUrl.trim();
  if (targetUrl.length === 0 || targetUrl === "about:blank") {
    return {
      action: "reject",
      reason: "deferred-navigation-unsupported"
    };
  }
  const resolved = resolveBrowserNavigationUrl(targetUrl);
  if (!resolved.url) {
    return { action: "reject", reason: "unsupported-url" };
  }
  if (haveSameOrigin(input.currentUrl, resolved.url)) {
    return { action: "navigate-current", url: resolved.url };
  }
  return { action: "open-browser", url: resolved.url };
}

function haveSameOrigin(currentUrl: string, targetUrl: string): boolean {
  try {
    return new URL(currentUrl).origin === new URL(targetUrl).origin;
  } catch {
    return false;
  }
}

function logWorkspaceAppPopupRejection(input: {
  contents: WorkspaceAppWindowOpenContents;
  decision: Extract<WorkspaceAppWindowOpenDecision, { action: "reject" }>;
  details: Parameters<BrowserWebviewWindowOpenHandler>[0];
  logger?: WorkspaceAppWindowOpenLogger;
}): void {
  if (input.decision.reason === "post-unsupported") {
    input.logger?.warn?.("workspace app guest rejected POST popup", {
      contentType: input.details.postBody?.contentType ?? null,
      url: input.details.url,
      webContentsId: input.contents.id
    });
    return;
  }
  if (input.decision.reason === "deferred-navigation-unsupported") {
    input.logger?.warn?.("workspace app guest rejected deferred popup", {
      webContentsId: input.contents.id
    });
    return;
  }
  input.logger?.warn?.("workspace app guest ignored unsupported open-url", {
    url: input.details.url,
    webContentsId: input.contents.id
  });
}

function notifyWorkspaceAppPopupRejected(
  ownerWindow: WorkspaceAppWindowOpenOwnerWindow,
  payload: DesktopWorkspaceAppPopupRejectedEvent
): void {
  if (
    ownerWindow.isDestroyed?.() === true ||
    ownerWindow.webContents.isDestroyed?.() === true
  ) {
    return;
  }
  ownerWindow.webContents.send(
    desktopIpcChannels.browser.workspaceAppPopupRejected,
    payload
  );
}

export function dispatchWorkspaceAppOpenUrl({
  contents,
  logger,
  ownerWindow,
  producer,
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
    producer,
    sourceNodeId: payload.sourceNodeId,
    url: payload.url,
    webContentsId: contents.id
  });
  ownerWindow.webContents.send(desktopIpcChannels.browser.event, payload);
  return true;
}
