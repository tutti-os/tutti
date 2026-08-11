import type { Event, WebContents, WebPreferences } from "electron";
import {
  isBrowserSessionPartitionAllowed,
  type BrowserSessionPartitionAllowedOptions
} from "../core/session.ts";
import { resolveBrowserNavigationUrl } from "../core/url.ts";
import {
  installBrowserGuestWindowOpenRouter,
  restoreBrowserGuestWindowOpenRouter,
  type BrowserGuestWindowOpenHandler
} from "./guestWindowOpenRouter.ts";
import { applyBrowserGuestUserAgent } from "./userAgent.ts";
import type { BrowserNodeElectronLogger } from "./types.ts";

export interface BrowserWebviewSecurityInput {
  allowedSessionPartitions?: BrowserSessionPartitionAllowedOptions;
  params: Record<string, string>;
  resolvePreload?: BrowserWebviewPreloadResolver;
  webPreferences: WebPreferences;
}

export interface BrowserWebviewSecurityResult {
  allowed: boolean;
  reason: string | null;
}

export type BrowserNodeWebviewMatcher = (
  params: Record<string, string>
) => boolean;

interface PendingBrowserWebviewAttach {
  params: Readonly<Record<string, string>>;
}

export interface BrowserWebviewPreloadResolverInput {
  params: Readonly<Record<string, string>>;
}

export type BrowserWebviewPreloadResolver = (
  input: BrowserWebviewPreloadResolverInput
) => string | null | undefined;

export type BrowserWebviewWindowOpenHandler = BrowserGuestWindowOpenHandler;

export interface BrowserWebviewGuestAttachment {
  windowOpenHandler?: BrowserWebviewWindowOpenHandler;
}

export interface BrowserWebviewGuestAttachedInput {
  params: Readonly<Record<string, string>>;
}

function isBrowserNodeInitialWebviewUrl(url: string | undefined): boolean {
  return (url ?? "").trim() === "about:blank";
}

export function isBrowserNodeWebviewAttach(
  params: Record<string, string>,
  allowedSessionPartitions?: BrowserSessionPartitionAllowedOptions
): boolean {
  return (
    params["data-browser-node-webview"] === "true" ||
    isBrowserSessionPartitionAllowed(params.partition, allowedSessionPartitions)
  );
}

function shouldAllowBrowserNodeNativePopups(
  params: Record<string, string>
): boolean {
  return (
    params["data-browser-node-webview"] === "true" ||
    isBrowserSessionPartitionAllowed(params.partition)
  );
}

function getPopupLogMetadata(url: string): Record<string, unknown> {
  try {
    const parsed = new URL(url);
    return {
      popupOrigin: parsed.origin,
      popupPath: parsed.pathname,
      popupProtocol: parsed.protocol
    };
  } catch {
    return {
      popupOrigin: null,
      popupPath: null,
      popupProtocol: null
    };
  }
}

function externalizeBrowserNodePopupWindow({
  guestWebContentsId,
  logger,
  openExternal,
  url
}: {
  guestWebContentsId: number | null;
  logger?: BrowserNodeElectronLogger;
  openExternal: (url: string) => Promise<void> | void;
  url: string;
}) {
  logger?.info?.("Browser Node webview popup externalized", {
    guestWebContentsId,
    ...getPopupLogMetadata(url)
  });
  const resolved = resolveBrowserNavigationUrl(url);
  if (resolved.url) {
    void Promise.resolve(openExternal(resolved.url)).catch(() => undefined);
  }
  return { action: "deny" as const };
}

export function enforceBrowserWebviewSecurity({
  allowedSessionPartitions,
  params,
  resolvePreload,
  webPreferences
}: BrowserWebviewSecurityInput): BrowserWebviewSecurityResult {
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.contextIsolation = true;
  webPreferences.javascript = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.plugins = false;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  delete webPreferences.preload;

  const partition = params.partition;
  if (
    !partition ||
    !isBrowserSessionPartitionAllowed(partition, allowedSessionPartitions)
  ) {
    return {
      allowed: false,
      reason: "Unsupported Browser Node session partition"
    };
  }

  if (isBrowserNodeInitialWebviewUrl(params.src)) {
    params.src = "about:blank";
  } else {
    const resolved = resolveBrowserNavigationUrl(params.src ?? "about:blank");
    if (!resolved.url) {
      return {
        allowed: false,
        reason: "Unsupported browser URL"
      };
    }
    params.src = resolved.url;
  }

  const preload = resolvePreload?.({ params: { ...params } });
  const resolvedPreload = typeof preload === "string" ? preload.trim() : "";
  if (resolvedPreload.length > 0) {
    webPreferences.preload = resolvedPreload;
    // Iframe-hosted editors still need the guest preload to report interactions
    // so the host can focus the owning Browser Node.
    webPreferences.nodeIntegrationInSubFrames = true;
  }

  return { allowed: true, reason: null };
}

export interface InstallBrowserWebviewSecurityInput {
  allowedSessionPartitions?: BrowserSessionPartitionAllowedOptions;
  contents: WebContents;
  logger?: BrowserNodeElectronLogger;
  onGuestAttached?: (guestContents: WebContents) => void;
  openExternal: (url: string) => Promise<void> | void;
  resolveGuestAttachment?: (
    guestContents: WebContents,
    input: BrowserWebviewGuestAttachedInput
  ) => BrowserWebviewGuestAttachment | undefined;
  resolvePreload?: BrowserWebviewPreloadResolver;
  shouldHandleWebview?: BrowserNodeWebviewMatcher;
}

export function installBrowserWebviewSecurity({
  allowedSessionPartitions,
  contents,
  logger,
  onGuestAttached,
  openExternal,
  resolveGuestAttachment,
  resolvePreload,
  shouldHandleWebview
}: InstallBrowserWebviewSecurityInput): () => void {
  const pendingBrowserAttaches: PendingBrowserWebviewAttach[] = [];

  const handleWillAttachWebview = (
    event: Event,
    webPreferences: WebPreferences,
    params: Record<string, string>
  ) => {
    const shouldHandle =
      shouldHandleWebview?.(params) ??
      isBrowserNodeWebviewAttach(params, allowedSessionPartitions);
    logger?.debug?.("Browser Node webview will attach", {
      partition: params.partition ?? null,
      shouldHandle,
      src: params.src ?? null
    });
    if (!shouldHandle) {
      return;
    }

    const allowNativePopups = shouldAllowBrowserNodeNativePopups(params);
    if (allowNativePopups) {
      params.allowpopups = "true";
    }
    logger?.info?.("Browser Node webview popup policy applied", {
      allowNativePopups,
      allowpopups: params.allowpopups ?? null,
      partition: params.partition ?? null,
      src: params.src ?? null
    });

    const result = enforceBrowserWebviewSecurity({
      allowedSessionPartitions,
      params,
      resolvePreload,
      webPreferences
    });
    if (!result.allowed) {
      logger?.warn?.("Browser Node webview blocked", { reason: result.reason });
      event.preventDefault();
      return;
    }
    pendingBrowserAttaches.push({ params: { ...params } });
    logger?.debug?.("Browser Node webview attach allowed", {
      partition: params.partition ?? null,
      src: params.src ?? null
    });
  };

  const handleDidAttachWebview = (
    _event: Event,
    guestContents: WebContents
  ) => {
    const pendingAttach = pendingBrowserAttaches.shift();
    if (!pendingAttach) {
      logger?.debug?.("Browser Node webview did attach ignored", {
        guestWebContentsId: guestContents.id ?? null,
        pendingBrowserAttachCount: pendingBrowserAttaches.length
      });
      return;
    }

    const denyPopup: BrowserWebviewWindowOpenHandler = () => ({
      action: "deny"
    });
    installBrowserGuestWindowOpenRouter({
      contents: guestContents,
      fallbackHandler: denyPopup
    });
    const fallbackHandler: BrowserWebviewWindowOpenHandler = ({ url }) =>
      externalizeBrowserNodePopupWindow({
        guestWebContentsId: guestContents.id ?? null,
        logger,
        openExternal,
        url
      });
    try {
      applyBrowserGuestUserAgent(guestContents, logger);
      const attachment = resolveGuestAttachment?.(guestContents, {
        params: pendingAttach.params
      });
      installBrowserGuestWindowOpenRouter({
        contents: guestContents,
        fallbackHandler,
        ...(attachment?.windowOpenHandler
          ? { hostHandler: attachment.windowOpenHandler }
          : {})
      });
    } catch (error) {
      logger?.warn?.("Browser Node webview guest setup failed", {
        error: error instanceof Error ? error.message : String(error),
        guestWebContentsId: guestContents.id ?? null
      });
      return;
    }
    try {
      onGuestAttached?.(guestContents);
    } catch (error) {
      restoreBrowserGuestWindowOpenRouter({
        contents: guestContents,
        fallbackHandler: denyPopup
      });
      logger?.warn?.("Browser Node webview guest setup failed", {
        error: error instanceof Error ? error.message : String(error),
        guestWebContentsId: guestContents.id ?? null
      });
      return;
    }
    logger?.debug?.("Browser Node webview guest attached", {
      guestWebContentsId: guestContents.id ?? null,
      pendingBrowserAttachCount: pendingBrowserAttaches.length
    });
  };

  contents.on("will-attach-webview", handleWillAttachWebview);
  contents.on("did-attach-webview", handleDidAttachWebview);

  return () => {
    contents.off("will-attach-webview", handleWillAttachWebview);
    contents.off("did-attach-webview", handleDidAttachWebview);
  };
}
