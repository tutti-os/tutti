import type { BrowserNodeFeature } from "./feature.ts";
import {
  normalizeBrowserComparableUrl,
  normalizeHostBrowserComparableUrl
} from "./url.ts";
import type {
  BrowserNodeNavigationPolicy,
  BrowserNodeRuntimeState,
  BrowserNodeSessionMode
} from "./types.ts";

export interface BrowserNodeControllerState {
  displayUrl: string;
  draftUrl: string;
  runtime: BrowserNodeRuntimeState;
}

export interface BrowserNodeController {
  getState(): BrowserNodeControllerState;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  release(): void;
  retain(): void;
  setDraftUrl(nextUrl: string): void;
  sync(): void;
  subscribe(listener: () => void): () => void;
  submitDraftUrl(): Promise<void>;
}

interface BrowserNodeControllerContext {
  defaultUrl: string;
  feature: BrowserNodeFeature;
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition?: string | null;
  syncDefaultUrl: boolean;
}

interface BrowserNodeControllerEntry {
  connectedRelease: (() => void) | null;
  controller: BrowserNodeController;
  context: BrowserNodeControllerContext;
  lastColdActivationUrl: string | null;
  listeners: Set<() => void>;
  pendingColdActivationUrl: string | null;
  refCount: number;
  runtimeUnsubscribe: (() => void) | null;
  state: BrowserNodeControllerState;
}

const controllerRegistry = new Map<string, BrowserNodeControllerEntry>();

export function acquireBrowserNodeController(input: {
  defaultUrl: string;
  feature: BrowserNodeFeature;
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  profileId?: string | null;
  sessionMode?: BrowserNodeSessionMode;
  sessionPartition?: string | null;
  syncDefaultUrl?: boolean;
}): BrowserNodeController {
  const existing = controllerRegistry.get(input.nodeId);
  const entry =
    existing ??
    createBrowserNodeControllerEntry({
      defaultUrl: input.defaultUrl,
      feature: input.feature,
      navigationPolicy: input.navigationPolicy,
      nodeId: input.nodeId,
      profileId: input.profileId ?? null,
      sessionMode: input.sessionMode ?? "shared",
      sessionPartition: input.sessionPartition,
      syncDefaultUrl: input.syncDefaultUrl ?? false
    });

  entry.context = {
    defaultUrl: input.defaultUrl,
    feature: input.feature,
    navigationPolicy: input.navigationPolicy,
    nodeId: input.nodeId,
    profileId: input.profileId ?? null,
    sessionMode: input.sessionMode ?? "shared",
    sessionPartition: input.sessionPartition,
    syncDefaultUrl: input.syncDefaultUrl ?? false
  };

  if (!existing) {
    controllerRegistry.set(input.nodeId, entry);
  }

  reconcileBrowserNodeControllerState(entry, {
    allowAutoActivate: false,
    notifyListeners: false
  });

  return entry.controller;
}

function createBrowserNodeControllerEntry(
  context: BrowserNodeControllerContext
): BrowserNodeControllerEntry {
  const runtime = context.feature.runtimeStore.getNodeState(context.nodeId);
  const displayUrl = resolveBrowserNodeDisplayUrl(runtime, context.defaultUrl);
  const entry = {
    connectedRelease: null,
    controller: null as unknown as BrowserNodeController,
    context,
    lastColdActivationUrl: resolveInitialLastColdActivationUrl(
      runtime,
      context.defaultUrl
    ),
    listeners: new Set(),
    pendingColdActivationUrl: null,
    refCount: 0,
    runtimeUnsubscribe: null,
    state: {
      displayUrl,
      draftUrl: displayUrl,
      runtime
    }
  } as BrowserNodeControllerEntry;

  entry.controller = {
    getState() {
      return entry.state;
    },
    goBack() {
      return entry.context.feature.hostApi.goBack({
        nodeId: entry.context.nodeId
      });
    },
    goForward() {
      return entry.context.feature.hostApi.goForward({
        nodeId: entry.context.nodeId
      });
    },
    reload() {
      return entry.context.feature.hostApi.reload({
        nodeId: entry.context.nodeId
      });
    },
    release() {
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount > 0) {
        return;
      }

      entry.connectedRelease?.();
      entry.connectedRelease = null;
      entry.runtimeUnsubscribe?.();
      entry.runtimeUnsubscribe = null;
      controllerRegistry.delete(entry.context.nodeId);
    },
    retain() {
      entry.refCount += 1;
      if (entry.refCount > 1) {
        return;
      }

      if (!controllerRegistry.has(entry.context.nodeId)) {
        controllerRegistry.set(entry.context.nodeId, entry);
      }
      entry.connectedRelease = entry.context.feature.connect();
      entry.runtimeUnsubscribe = entry.context.feature.runtimeStore.subscribe(
        () => {
          reconcileBrowserNodeControllerState(entry, {
            allowAutoActivate: true,
            notifyListeners: true
          });
        }
      );
      reconcileBrowserNodeControllerState(entry, {
        allowAutoActivate: true,
        notifyListeners: true
      });
    },
    setDraftUrl(nextUrl) {
      if (entry.state.draftUrl === nextUrl) {
        return;
      }

      entry.state = {
        ...entry.state,
        draftUrl: nextUrl
      };
      notifyBrowserNodeControllerListeners(entry);
    },
    sync() {
      reconcileBrowserNodeControllerState(entry, {
        allowAutoActivate: true,
        notifyListeners: true
      });
    },
    subscribe(listener) {
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    async submitDraftUrl() {
      const resolved = entry.context.feature.resolveAddressInput(
        entry.state.draftUrl
      );
      if (!resolved.url) {
        return;
      }

      if (entry.state.draftUrl !== resolved.url) {
        entry.state = {
          ...entry.state,
          draftUrl: resolved.url
        };
        notifyBrowserNodeControllerListeners(entry);
      }

      await entry.context.feature.hostApi.navigate({
        navigationPolicy: entry.context.navigationPolicy,
        nodeId: entry.context.nodeId,
        url: resolved.url
      });
    }
  };

  return entry;
}

function resolveInitialLastColdActivationUrl(
  runtime: BrowserNodeRuntimeState,
  defaultUrl: string
): string | null {
  const trimmedUrl = defaultUrl.trim();
  if (
    runtime.lifecycle === "cold" ||
    runtime.error !== null ||
    trimmedUrl.length === 0 ||
    trimmedUrl === "about:blank"
  ) {
    return null;
  }

  const comparableDefaultUrl = normalizeBrowserComparableUrl(trimmedUrl);
  const comparableRuntimeUrl = runtime.url
    ? normalizeBrowserComparableUrl(runtime.url)
    : null;
  return comparableDefaultUrl !== null &&
    comparableDefaultUrl === comparableRuntimeUrl
    ? trimmedUrl
    : null;
}

function notifyBrowserNodeControllerListeners(
  entry: BrowserNodeControllerEntry
): void {
  for (const listener of entry.listeners) {
    listener();
  }
}

function resolveBrowserNodeDisplayUrl(
  runtime: BrowserNodeRuntimeState,
  defaultUrl: string
): string {
  const resolvedRuntimeUrl = runtime.url?.trim() ?? "";
  return resolvedRuntimeUrl.length > 0 ? resolvedRuntimeUrl : defaultUrl;
}

function reconcileBrowserNodeControllerState(
  entry: BrowserNodeControllerEntry,
  options: {
    allowAutoActivate: boolean;
    notifyListeners: boolean;
  }
): void {
  const runtime = entry.context.feature.runtimeStore.getNodeState(
    entry.context.nodeId
  );
  const displayUrl = resolveBrowserNodeDisplayUrl(
    runtime,
    entry.context.defaultUrl
  );
  const nextDraftUrl =
    displayUrl !== entry.state.displayUrl ? displayUrl : entry.state.draftUrl;

  const changed =
    entry.state.runtime !== runtime ||
    entry.state.displayUrl !== displayUrl ||
    entry.state.draftUrl !== nextDraftUrl;

  if (changed) {
    entry.state = {
      displayUrl,
      draftUrl: nextDraftUrl,
      runtime
    };
    if (options.notifyListeners) {
      notifyBrowserNodeControllerListeners(entry);
    }
  }

  if (options.allowAutoActivate) {
    void maybeActivateBrowserNodeDefaultUrl(entry).catch(() => undefined);
  }
}

function isSameOriginComparableBrowserUrl(
  left: string | null,
  right: string | null
): boolean {
  if (!left || !right) {
    return false;
  }
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

async function maybeActivateBrowserNodeDefaultUrl(
  entry: BrowserNodeControllerEntry
): Promise<void> {
  const {
    defaultUrl,
    feature,
    navigationPolicy,
    nodeId,
    profileId,
    sessionMode,
    sessionPartition,
    syncDefaultUrl
  } = entry.context;
  const trimmedUrl = defaultUrl.trim();
  const comparableDefaultUrl = normalizeHostBrowserComparableUrl(trimmedUrl);
  const comparableRuntimeUrl = entry.state.runtime.url
    ? normalizeHostBrowserComparableUrl(entry.state.runtime.url)
    : null;
  const shouldActivateColdNode = entry.state.runtime.lifecycle === "cold";
  // Host-driven sync must not fight same-origin guest redirects
  // (e.g. example.com → example.com/dashboard after Cookie import).
  // Runtime URL follows guest navigation; only cross-origin / missing
  // runtime URLs (or hard errors) should force activate().
  const runtimeNeedsHostNavigation =
    entry.state.runtime.error !== null ||
    comparableRuntimeUrl === null ||
    !isSameOriginComparableBrowserUrl(
      comparableRuntimeUrl,
      comparableDefaultUrl
    );
  const shouldSyncDefaultUrl =
    syncDefaultUrl &&
    entry.state.runtime.lifecycle !== "cold" &&
    comparableDefaultUrl !== null &&
    runtimeNeedsHostNavigation &&
    (comparableRuntimeUrl !== comparableDefaultUrl ||
      entry.state.runtime.error !== null) &&
    entry.lastColdActivationUrl !== trimmedUrl;
  if (
    trimmedUrl.length === 0 ||
    trimmedUrl === "about:blank" ||
    entry.state.runtime.isLoading ||
    entry.pendingColdActivationUrl === trimmedUrl ||
    (!shouldActivateColdNode && !shouldSyncDefaultUrl) ||
    (shouldActivateColdNode &&
      entry.state.runtime.error !== null &&
      entry.lastColdActivationUrl === trimmedUrl)
  ) {
    return;
  }

  entry.pendingColdActivationUrl = trimmedUrl;
  try {
    await feature.hostApi.activate({
      navigationPolicy,
      nodeId,
      profileId,
      sessionMode,
      sessionPartition,
      url: trimmedUrl
    });
    entry.lastColdActivationUrl = trimmedUrl;
  } finally {
    if (entry.pendingColdActivationUrl === trimmedUrl) {
      entry.pendingColdActivationUrl = null;
    }
  }
}
