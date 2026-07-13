import type { Event, WebContents, WebPreferences } from "electron";
import {
  isBrowserSessionPartitionAllowed,
  type BrowserSessionPartitionAllowedOptions
} from "../core/session.ts";
import { resolveBrowserNavigationUrl } from "../core/url.ts";
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

export interface BrowserWebviewGuestAttachedInput {
  params: Readonly<Record<string, string>>;
}

export interface BrowserWebviewPreloadResolverInput {
  params: Readonly<Record<string, string>>;
}

export type BrowserWebviewPreloadResolver = (
  input: BrowserWebviewPreloadResolverInput
) => string | null | undefined;

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
  onGuestAttached?: (
    guestContents: WebContents,
    input: BrowserWebviewGuestAttachedInput
  ) => void;
  openExternal: (url: string) => Promise<void> | void;
  resolvePreload?: BrowserWebviewPreloadResolver;
  resolveSessionIdentity: (partition: string) => object;
  shouldHandleWebview?: BrowserNodeWebviewMatcher;
  validateWebviewAttach?: BrowserNodeWebviewMatcher;
}

export function installBrowserWebviewSecurity({
  allowedSessionPartitions,
  contents,
  logger,
  onGuestAttached,
  openExternal,
  resolvePreload,
  resolveSessionIdentity,
  shouldHandleWebview,
  validateWebviewAttach
}: InstallBrowserWebviewSecurityInput): () => void {
  const pendingBrowserAttaches = new Map<
    object,
    PendingBrowserWebviewAttach[]
  >();

  const resolveAttachIdentity = (partition: string): object =>
    resolveSessionIdentity(partition);
  const getPendingAttachCount = () =>
    [...pendingBrowserAttaches.values()].reduce(
      (count, pending) => count + pending.length,
      0
    );
  const enqueuePendingAttach = (
    identity: object,
    pending: PendingBrowserWebviewAttach
  ) => {
    const queue = pendingBrowserAttaches.get(identity) ?? [];
    queue.push(pending);
    pendingBrowserAttaches.set(identity, queue);
  };
  const dequeuePendingAttach = (
    identity: object
  ): PendingBrowserWebviewAttach | null => {
    const queue = pendingBrowserAttaches.get(identity);
    const pending = queue?.shift() ?? null;
    if (queue?.length === 0) {
      pendingBrowserAttaches.delete(identity);
    }
    return pending;
  };

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
    if (validateWebviewAttach?.(params) === false) {
      logger?.warn?.("Browser Node webview blocked", {
        reason: "Host webview attachment policy rejected the request"
      });
      event.preventDefault();
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
    const partition = params.partition;
    if (!partition) {
      logger?.warn?.("Browser Node webview blocked", {
        reason: "Validated webview partition is unavailable"
      });
      event.preventDefault();
      return;
    }
    let sessionIdentity: object;
    try {
      sessionIdentity = resolveAttachIdentity(partition);
    } catch (error) {
      logger?.warn?.("Browser Node webview blocked", {
        error: error instanceof Error ? error.message : String(error),
        reason: "Webview session identity resolution failed"
      });
      event.preventDefault();
      return;
    }
    enqueuePendingAttach(sessionIdentity, { params: { ...params } });
    logger?.debug?.("Browser Node webview attach allowed", {
      partition: params.partition ?? null,
      src: params.src ?? null
    });
  };

  const handleDidAttachWebview = (
    _event: Event,
    guestContents: WebContents
  ) => {
    const pendingAttach = dequeuePendingAttach(guestContents.session);
    if (!pendingAttach) {
      logger?.debug?.("Browser Node webview did attach ignored", {
        guestWebContentsId: guestContents.id ?? null,
        pendingBrowserAttachCount: getPendingAttachCount()
      });
      return;
    }
    const partition = pendingAttach.params.partition;

    applyBrowserGuestUserAgent(guestContents, logger);
    guestContents.setWindowOpenHandler(({ url }) => {
      return externalizeBrowserNodePopupWindow({
        guestWebContentsId: guestContents.id ?? null,
        logger,
        openExternal,
        url
      });
    });
    onGuestAttached?.(guestContents, {
      params: pendingAttach.params
    });
    logger?.debug?.("Browser Node webview guest attached", {
      guestWebContentsId: guestContents.id ?? null,
      partition,
      pendingBrowserAttachCount: getPendingAttachCount()
    });
  };

  contents.on("will-attach-webview", handleWillAttachWebview);
  contents.on("did-attach-webview", handleDidAttachWebview);

  return () => {
    contents.off("will-attach-webview", handleWillAttachWebview);
    contents.off("did-attach-webview", handleDidAttachWebview);
    pendingBrowserAttaches.clear();
  };
}
