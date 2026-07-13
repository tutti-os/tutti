import type { BrowserNodeEvent, BrowserNodeRuntimeState } from "./types.ts";

export interface BrowserNodeRuntimeStore {
  applyEvent(event: BrowserNodeEvent): void;
  clearAll(): void;
  clearNode(nodeId: string): void;
  getNodeState(nodeId: string): BrowserNodeRuntimeState;
  getSnapshot(): Record<string, BrowserNodeRuntimeState | undefined>;
  subscribe(listener: () => void): () => void;
}

const defaultBrowserNodeRuntimeState: BrowserNodeRuntimeState = {
  canGoBack: false,
  canGoForward: false,
  downloads: [],
  error: null,
  findResult: null,
  isAttachedToWindow: false,
  isLoading: false,
  isOccluded: false,
  lifecycle: "cold",
  title: null,
  url: null,
  zoomFactor: 1
};

const chromiumErrorPageUrlPrefix = "chrome-error://";

function isChromiumErrorPageUrl(value: string | null | undefined): boolean {
  return value?.trim().startsWith(chromiumErrorPageUrlPrefix) === true;
}

function normalizePublishedBrowserValue(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? "";
  if (
    trimmed.length === 0 ||
    trimmed === "about:blank" ||
    isChromiumErrorPageUrl(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function shouldClearLoadError({
  isLoading,
  url
}: {
  isLoading: boolean;
  url: string | null;
}): boolean {
  return isLoading && !isChromiumErrorPageUrl(url);
}

export function createBrowserNodeRuntimeStore(): BrowserNodeRuntimeStore {
  const listeners = new Set<() => void>();
  let runtimeByNodeId: Record<string, BrowserNodeRuntimeState | undefined> = {};

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    applyEvent(event) {
      if (event.type === "open-url") {
        return;
      }

      if (event.type === "closed") {
        if (!runtimeByNodeId[event.nodeId]) {
          return;
        }
        const next = { ...runtimeByNodeId };
        delete next[event.nodeId];
        runtimeByNodeId = next;
        notify();
        return;
      }

      const previous =
        runtimeByNodeId[event.nodeId] ?? defaultBrowserNodeRuntimeState;
      const next = resolveNextRuntimeState(previous, event);

      runtimeByNodeId = {
        ...runtimeByNodeId,
        [event.nodeId]: next
      };
      notify();
    },
    clearAll() {
      if (Object.keys(runtimeByNodeId).length === 0) {
        return;
      }
      runtimeByNodeId = {};
      notify();
    },
    clearNode(nodeId) {
      const normalized = nodeId.trim();
      if (normalized.length === 0 || !runtimeByNodeId[normalized]) {
        return;
      }
      const next = { ...runtimeByNodeId };
      delete next[normalized];
      runtimeByNodeId = next;
      notify();
    },
    getNodeState(nodeId) {
      return runtimeByNodeId[nodeId] ?? defaultBrowserNodeRuntimeState;
    },
    getSnapshot() {
      return runtimeByNodeId;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function resolveNextRuntimeState(
  previous: BrowserNodeRuntimeState,
  event: Exclude<BrowserNodeEvent, { type: "closed" | "open-url" }>
): BrowserNodeRuntimeState {
  if (event.type === "state") {
    return resolveNextState(previous, event);
  }
  if (event.type === "find-result") {
    return {
      ...previous,
      findResult: {
        activeMatchOrdinal: event.activeMatchOrdinal,
        finalUpdate: event.finalUpdate,
        matches: event.matches,
        query: event.query
      }
    };
  }
  if (event.type === "download") {
    return {
      ...previous,
      downloads: upsertBrowserNodeDownload(previous.downloads, event.download)
    };
  }
  return {
    ...previous,
    error: {
      code: event.code,
      diagnosticMessage: event.diagnosticMessage,
      params: event.params
    }
  };
}

function upsertBrowserNodeDownload(
  downloads: readonly BrowserNodeRuntimeState["downloads"][number][],
  download: BrowserNodeRuntimeState["downloads"][number]
): readonly BrowserNodeRuntimeState["downloads"][number][] {
  const existingIndex = downloads.findIndex((item) => item.id === download.id);
  if (existingIndex < 0) {
    return [download, ...downloads];
  }
  const next = [...downloads];
  next[existingIndex] = download;
  return next;
}

function resolveNextState(
  previous: BrowserNodeRuntimeState,
  event: Extract<BrowserNodeEvent, { type: "state" }>
): BrowserNodeRuntimeState {
  const nextUrl =
    normalizePublishedBrowserValue(event.url) ??
    (event.lifecycle !== "cold" ? previous.url : null);
  const nextTitle =
    normalizePublishedBrowserValue(event.title) ??
    (event.lifecycle !== "cold" ? previous.title : null);

  return {
    ...previous,
    canGoBack: event.canGoBack,
    canGoForward: event.canGoForward,
    error: shouldClearLoadError({
      isLoading: event.isLoading,
      url: event.url
    })
      ? null
      : previous.error,
    isAttachedToWindow: event.isAttachedToWindow ?? previous.isAttachedToWindow,
    isLoading: event.isLoading,
    isOccluded: event.isOccluded,
    lifecycle: event.lifecycle,
    title: nextTitle,
    url: nextUrl,
    zoomFactor: event.zoomFactor ?? previous.zoomFactor
  };
}
