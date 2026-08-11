import type { BrowserNodeFeature } from "./feature.ts";
import { browserNodeGuestInteractionHostChannel } from "./guestInteraction.ts";
import { resolveBrowserSessionPartition } from "./session.ts";
import type {
  BrowserNodeAutomationTargetMetadata,
  BrowserNodeHostApi,
  BrowserNodeLifecycle,
  BrowserNodeNavigationPolicy,
  BrowserNodePrepareSessionInput,
  BrowserNodeSessionMode
} from "./types.ts";
import type { BrowserNodeWebviewTag } from "../react/webviewTag.ts";

const browserGuestUnregisterGraceMs = 250;
const browserNodeInitialWebviewSrc = "about:blank";

export interface BrowserNodeWebviewControllerState {
  devToolsContextMenu: BrowserNodeWebviewContextMenuPoint | null;
  shouldRenderWebview: boolean;
  webviewKey: string;
  webviewPartition: string;
  webviewSrc: string;
}

export interface BrowserNodeWebviewContextMenuPoint {
  x: number;
  y: number;
}

export interface BrowserNodeWebviewController {
  dismissDevToolsContextMenu(): void;
  getState(): BrowserNodeWebviewControllerState;
  openDevToolsFromContextMenu(): Promise<void>;
  release(): void;
  retain(): void;
  setWebview(element: BrowserNodeWebviewTag | null): void;
  sync(): void;
  subscribe(listener: () => void): () => void;
}

interface BrowserNodeWebviewControllerContext {
  automationTarget?: BrowserNodeAutomationTargetMetadata | null;
  feature: BrowserNodeFeature;
  initialUrl: string;
  lifecycle: BrowserNodeLifecycle;
  materializeCold?: boolean;
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  onGuestInteraction?: () => void;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition?: string | null;
}

interface BrowserNodeWebviewControllerEntry {
  attachedListeners: Array<{
    event: string;
    listener: EventListener;
  }>;
  context: BrowserNodeWebviewControllerContext;
  controller: BrowserNodeWebviewController;
  listeners: Set<() => void>;
  lastAutomationTargetSync: BrowserNodeHostEffectSnapshot<BrowserNodeAutomationTargetMetadata> | null;
  lastSessionPreparation: BrowserNodeHostEffectSnapshot<BrowserNodePrepareSessionInput> | null;
  refCount: number;
  registeredGuestId: number | null;
  registeringGuestId: number | null;
  state: BrowserNodeWebviewControllerState;
  webview: BrowserNodeWebviewTag | null;
}

interface BrowserNodeHostEffectSnapshot<T> {
  hostApi: BrowserNodeHostApi;
  payload: T;
}

interface BrowserNodeGuestInteractionEvent extends Event {
  channel?: unknown;
}

const webviewControllerRegistry = new Map<
  string,
  BrowserNodeWebviewControllerEntry
>();
const pendingGuestIdsByNodeId = new Map<string, number>();
const pendingUnregisterTimersByNodeId = new Map<
  string,
  ReturnType<typeof globalThis.setTimeout>
>();

export function acquireBrowserNodeWebviewController(input: {
  automationTarget?: BrowserNodeAutomationTargetMetadata | null;
  feature: BrowserNodeFeature;
  initialUrl: string;
  lifecycle: BrowserNodeLifecycle;
  materializeCold?: boolean;
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  onGuestInteraction?: () => void;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition?: string | null;
}): BrowserNodeWebviewController {
  const existing = webviewControllerRegistry.get(input.nodeId);
  const entry =
    existing ??
    createBrowserNodeWebviewControllerEntry({
      automationTarget: input.automationTarget,
      feature: input.feature,
      initialUrl: input.initialUrl,
      lifecycle: input.lifecycle,
      materializeCold: input.materializeCold,
      navigationPolicy: input.navigationPolicy,
      nodeId: input.nodeId,
      onGuestInteraction: input.onGuestInteraction,
      profileId: input.profileId,
      sessionMode: input.sessionMode,
      sessionPartition: input.sessionPartition
    });

  entry.context = {
    automationTarget: input.automationTarget,
    feature: input.feature,
    initialUrl: input.initialUrl,
    lifecycle: input.lifecycle,
    materializeCold: input.materializeCold,
    navigationPolicy: input.navigationPolicy,
    nodeId: input.nodeId,
    onGuestInteraction: input.onGuestInteraction,
    profileId: input.profileId,
    sessionMode: input.sessionMode,
    sessionPartition: input.sessionPartition
  };
  if (!existing) {
    webviewControllerRegistry.set(input.nodeId, entry);
  }
  return entry.controller;
}

function createBrowserNodeWebviewControllerEntry(
  context: BrowserNodeWebviewControllerContext
): BrowserNodeWebviewControllerEntry {
  const state = resolveBrowserNodeWebviewControllerState(context);
  const entry = {
    attachedListeners: [],
    context,
    controller: null as unknown as BrowserNodeWebviewController,
    listeners: new Set(),
    lastAutomationTargetSync: null,
    lastSessionPreparation: null,
    refCount: 0,
    registeredGuestId: null,
    registeringGuestId: null,
    state,
    webview: null
  } as BrowserNodeWebviewControllerEntry;

  entry.controller = {
    dismissDevToolsContextMenu() {
      setBrowserNodeDevToolsContextMenu(entry, null);
    },
    getState() {
      return entry.state;
    },
    async openDevToolsFromContextMenu() {
      setBrowserNodeDevToolsContextMenu(entry, null);
      try {
        await entry.context.feature.hostApi.openDevTools?.({
          nodeId: entry.context.nodeId
        });
      } catch (error) {
        reportBrowserNodeWebviewDiagnostic(
          entry,
          "devtools.open.failed",
          {
            error: error instanceof Error ? error.message : String(error),
            webContentsId: readBrowserNodeWebContentsId(entry.webview),
            webviewPartition: entry.state.webviewPartition
          },
          "warn"
        );
        throw error;
      }
    },
    release() {
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount > 0) {
        return;
      }
      scheduleBrowserNodeGuestUnregister(entry);
      detachBrowserNodeWebview(entry);
      webviewControllerRegistry.delete(entry.context.nodeId);
    },
    retain() {
      entry.refCount += 1;
      if (entry.refCount > 1) {
        return;
      }
      reconcileBrowserNodeWebviewControllerState(entry, {
        allowHostEffects: true,
        notifyListeners: true,
        rebindWebview: true
      });
    },
    setWebview(element) {
      if (entry.webview === element) {
        return;
      }
      detachBrowserNodeWebview(entry);
      entry.webview = element;
      attachBrowserNodeWebview(entry);
    },
    sync() {
      reconcileBrowserNodeWebviewControllerState(entry, {
        allowHostEffects: true,
        notifyListeners: true,
        rebindWebview: true
      });
    },
    subscribe(listener) {
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    }
  };

  return entry;
}

function resolveBrowserNodeWebviewControllerState(
  context: BrowserNodeWebviewControllerContext
): BrowserNodeWebviewControllerState {
  const webviewPartition = resolveBrowserSessionPartition({
    profileId: context.profileId,
    sessionMode: context.sessionMode,
    sessionPartition: context.sessionPartition
  });
  return {
    devToolsContextMenu: null,
    // Automation-created pages intentionally start at about:blank so Electron
    // can attach the CDP request guard before loading the requested URL. Only
    // the explicit creation intent may materialize a cold guest; target
    // metadata alone also exists on ordinary Browser tabs.
    shouldRenderWebview:
      context.lifecycle !== "cold" || context.materializeCold === true,
    webviewKey: `${context.nodeId}:${webviewPartition}`,
    webviewPartition,
    webviewSrc: browserNodeInitialWebviewSrc
  };
}

function reconcileBrowserNodeWebviewControllerState(
  entry: BrowserNodeWebviewControllerEntry,
  options: {
    allowHostEffects: boolean;
    notifyListeners: boolean;
    rebindWebview: boolean;
  }
): void {
  const nextState = resolveBrowserNodeWebviewControllerState(entry.context);
  const changed =
    entry.state.devToolsContextMenu !== nextState.devToolsContextMenu ||
    entry.state.shouldRenderWebview !== nextState.shouldRenderWebview ||
    entry.state.webviewKey !== nextState.webviewKey ||
    entry.state.webviewPartition !== nextState.webviewPartition ||
    entry.state.webviewSrc !== nextState.webviewSrc;

  if (options.allowHostEffects) {
    syncBrowserNodeAutomationTarget(entry);
    if (entry.context.lifecycle === "cold") {
      entry.lastSessionPreparation = null;
      scheduleBrowserNodeGuestUnregister(entry);
    } else {
      const pendingGuestId = clearPendingBrowserNodeGuestUnregister(
        entry.context.nodeId
      );
      if (entry.registeredGuestId === null && pendingGuestId !== null) {
        entry.registeredGuestId = pendingGuestId;
      }
      prepareBrowserNodeSession(entry);
    }
  }

  if (!changed) {
    if (
      options.rebindWebview &&
      entry.webview &&
      entry.attachedListeners.length === 0
    ) {
      attachBrowserNodeWebview(entry);
    }
    return;
  }

  entry.state = nextState;
  detachBrowserNodeWebview(entry);
  attachBrowserNodeWebview(entry);
  if (options.notifyListeners) {
    notifyBrowserNodeWebviewControllerListeners(entry);
  }
}

function syncBrowserNodeAutomationTarget(
  entry: BrowserNodeWebviewControllerEntry
): void {
  const automationTarget = entry.context.automationTarget;
  const hostApi = entry.context.feature.hostApi;
  if (!automationTarget || !hostApi.updateAutomationTarget) {
    entry.lastAutomationTargetSync = null;
    return;
  }
  const previous = entry.lastAutomationTargetSync;
  if (
    previous?.hostApi === hostApi &&
    areBrowserNodeAutomationTargetsEqual(previous.payload, automationTarget)
  ) {
    return;
  }

  const snapshot: BrowserNodeHostEffectSnapshot<BrowserNodeAutomationTargetMetadata> =
    {
      hostApi,
      payload: { ...automationTarget }
    };
  entry.lastAutomationTargetSync = snapshot;
  void hostApi
    .updateAutomationTarget({
      automationTarget: snapshot.payload,
      nodeId: entry.context.nodeId
    })
    .catch(() => {
      if (entry.lastAutomationTargetSync === snapshot) {
        entry.lastAutomationTargetSync = null;
      }
    });
}

function prepareBrowserNodeSession(
  entry: BrowserNodeWebviewControllerEntry
): void {
  const hostApi = entry.context.feature.hostApi;
  const payload: BrowserNodePrepareSessionInput = {
    automationTarget: cloneBrowserNodeAutomationTarget(
      entry.context.automationTarget
    ),
    navigationPolicy: cloneBrowserNodeNavigationPolicy(
      entry.context.navigationPolicy
    ),
    nodeId: entry.context.nodeId,
    profileId: entry.context.profileId,
    sessionMode: entry.context.sessionMode,
    sessionPartition: entry.context.sessionPartition,
    url: entry.context.initialUrl
  };
  const previous = entry.lastSessionPreparation;
  if (
    previous?.hostApi === hostApi &&
    areBrowserNodeSessionPreparationsEqual(previous.payload, payload)
  ) {
    return;
  }

  const snapshot: BrowserNodeHostEffectSnapshot<BrowserNodePrepareSessionInput> =
    {
      hostApi,
      payload
    };
  entry.lastSessionPreparation = snapshot;
  void hostApi.prepareSession(payload).catch(() => {
    if (entry.lastSessionPreparation === snapshot) {
      entry.lastSessionPreparation = null;
    }
  });
}

function cloneBrowserNodeAutomationTarget(
  value: BrowserNodeAutomationTargetMetadata | null | undefined
): BrowserNodeAutomationTargetMetadata | null | undefined {
  return value ? { ...value } : value;
}

function cloneBrowserNodeNavigationPolicy(
  value: BrowserNodeNavigationPolicy | null | undefined
): BrowserNodeNavigationPolicy | null | undefined {
  return value ? { ...value } : value;
}

function areBrowserNodeSessionPreparationsEqual(
  left: BrowserNodePrepareSessionInput,
  right: BrowserNodePrepareSessionInput
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.profileId === right.profileId &&
    left.sessionMode === right.sessionMode &&
    left.sessionPartition === right.sessionPartition &&
    left.url === right.url &&
    areBrowserNodeNavigationPoliciesEqual(
      left.navigationPolicy,
      right.navigationPolicy
    ) &&
    areBrowserNodeAutomationTargetsEqual(
      left.automationTarget,
      right.automationTarget
    )
  );
}

function areBrowserNodeNavigationPoliciesEqual(
  left: BrowserNodeNavigationPolicy | null | undefined,
  right: BrowserNodeNavigationPolicy | null | undefined
): boolean {
  if (left === right) {
    return true;
  }
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.mode === right.mode &&
    left.originUrl === right.originUrl
  );
}

function areBrowserNodeAutomationTargetsEqual(
  left: BrowserNodeAutomationTargetMetadata | null | undefined,
  right: BrowserNodeAutomationTargetMetadata | null | undefined
): boolean {
  if (left === right) {
    return true;
  }
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.agentSessionId === right.agentSessionId &&
    left.focused === right.focused &&
    left.selected === right.selected &&
    left.surfaceId === right.surfaceId &&
    left.surfaceRole === right.surfaceRole &&
    left.tabId === right.tabId &&
    left.workspaceId === right.workspaceId
  );
}

function setBrowserNodeDevToolsContextMenu(
  entry: BrowserNodeWebviewControllerEntry,
  devToolsContextMenu: BrowserNodeWebviewContextMenuPoint | null
): void {
  if (
    entry.state.devToolsContextMenu?.x === devToolsContextMenu?.x &&
    entry.state.devToolsContextMenu?.y === devToolsContextMenu?.y
  ) {
    return;
  }
  entry.state = {
    ...entry.state,
    devToolsContextMenu
  };
  notifyBrowserNodeWebviewControllerListeners(entry);
}

function notifyBrowserNodeWebviewControllerListeners(
  entry: BrowserNodeWebviewControllerEntry
): void {
  for (const listener of entry.listeners) {
    listener();
  }
}

function clearPendingBrowserNodeGuestUnregister(nodeId: string): number | null {
  const timerId = pendingUnregisterTimersByNodeId.get(nodeId);
  if (timerId !== undefined) {
    globalThis.clearTimeout(timerId);
    pendingUnregisterTimersByNodeId.delete(nodeId);
  }
  const pendingGuestId = pendingGuestIdsByNodeId.get(nodeId);
  pendingGuestIdsByNodeId.delete(nodeId);
  return typeof pendingGuestId === "number" && Number.isFinite(pendingGuestId)
    ? pendingGuestId
    : null;
}

function scheduleBrowserNodeGuestUnregister(
  entry: BrowserNodeWebviewControllerEntry
): void {
  const guestId = entry.registeredGuestId;
  const nodeId = entry.context.nodeId;
  entry.registeringGuestId = null;
  if (guestId === null) {
    clearPendingBrowserNodeGuestUnregister(nodeId);
    return;
  }

  entry.registeredGuestId = null;
  clearPendingBrowserNodeGuestUnregister(nodeId);
  pendingGuestIdsByNodeId.set(nodeId, guestId);
  const timerId = globalThis.setTimeout(() => {
    pendingUnregisterTimersByNodeId.delete(nodeId);
    const pendingGuestId = pendingGuestIdsByNodeId.get(nodeId);
    pendingGuestIdsByNodeId.delete(nodeId);
    if (
      typeof pendingGuestId !== "number" ||
      !Number.isFinite(pendingGuestId)
    ) {
      return;
    }
    const currentEntry = webviewControllerRegistry.get(nodeId);
    if (
      currentEntry &&
      currentEntry.refCount > 0 &&
      currentEntry.state.shouldRenderWebview
    ) {
      if (currentEntry.registeredGuestId === null) {
        currentEntry.registeredGuestId = pendingGuestId;
      }
      return;
    }

    void entry.context.feature.hostApi
      .unregisterGuest({
        nodeId: entry.context.nodeId,
        webContentsId: pendingGuestId
      })
      .catch(() => undefined);
  }, browserGuestUnregisterGraceMs);
  pendingUnregisterTimersByNodeId.set(nodeId, timerId);
}

function detachBrowserNodeWebview(
  entry: BrowserNodeWebviewControllerEntry
): void {
  if (!entry.webview) {
    entry.attachedListeners = [];
    return;
  }
  for (const record of entry.attachedListeners) {
    entry.webview.removeEventListener(record.event, record.listener);
  }
  entry.attachedListeners = [];
}

function attachBrowserNodeWebview(
  entry: BrowserNodeWebviewControllerEntry
): void {
  const webview = entry.webview;
  if (!webview || !entry.state.shouldRenderWebview) {
    return;
  }

  const registerGuest = async (): Promise<void> => {
    const guestId = readBrowserNodeWebContentsId(webview);
    if (
      typeof guestId !== "number" ||
      !Number.isFinite(guestId) ||
      guestId <= 0 ||
      entry.registeredGuestId === guestId ||
      entry.registeringGuestId === guestId
    ) {
      return;
    }

    clearPendingBrowserNodeGuestUnregister(entry.context.nodeId);
    entry.registeringGuestId = guestId;
    try {
      await entry.context.feature.hostApi.registerGuest({
        automationTarget: entry.context.automationTarget,
        navigationPolicy: entry.context.navigationPolicy,
        nodeId: entry.context.nodeId,
        profileId: entry.context.profileId,
        sessionMode: entry.context.sessionMode,
        sessionPartition: entry.context.sessionPartition,
        url: entry.context.initialUrl,
        webContentsId: guestId
      });
      entry.registeredGuestId = guestId;
    } finally {
      if (entry.registeringGuestId === guestId) {
        entry.registeringGuestId = null;
      }
    }
  };

  const handleDidAttach: EventListener = () => {
    void registerGuest().catch(() => undefined);
  };
  const handleDomReady: EventListener = () => {
    void registerGuest().catch(() => undefined);
  };
  const handleGuestInteraction: EventListener = () => {
    entry.context.onGuestInteraction?.();
    if (entry.context.automationTarget) {
      void entry.context.feature.hostApi
        .updateAutomationTarget?.({
          automationTarget: {
            ...entry.context.automationTarget,
            focused: true
          },
          nodeId: entry.context.nodeId
        })
        .catch(() => undefined);
    }
  };
  const handleGuestInteractionIpcMessage: EventListener = (event) => {
    if (
      (event as BrowserNodeGuestInteractionEvent).channel !==
      browserNodeGuestInteractionHostChannel
    ) {
      return;
    }
    handleGuestInteraction(event);
  };
  const handleDevToolsContextMenu: EventListener = (event) => {
    const hasNativeContextMenu =
      entry.context.feature.hostApi.showDevToolsContextMenu !== undefined;
    const hasInlineContextMenu =
      entry.context.feature.hostApi.openDevTools !== undefined;
    if (!hasNativeContextMenu && !hasInlineContextMenu) {
      return;
    }
    event.preventDefault();
    const point = resolveBrowserNodeContextMenuPoint(event, webview);
    if (hasNativeContextMenu) {
      void entry.context.feature.hostApi
        .showDevToolsContextMenu?.({
          label: entry.context.feature.i18n.t("actions.openDevTools"),
          nodeId: entry.context.nodeId,
          point
        })
        .catch((error: unknown) => {
          reportBrowserNodeWebviewDiagnostic(
            entry,
            "devtools.native-context-menu.failed",
            {
              error: error instanceof Error ? error.message : String(error),
              webContentsId: readBrowserNodeWebContentsId(webview),
              webviewPartition: entry.state.webviewPartition
            },
            "warn"
          );
        });
      return;
    }
    setBrowserNodeDevToolsContextMenu(entry, point);
  };

  const records = [
    { event: "did-attach", listener: handleDidAttach },
    { event: "dom-ready", listener: handleDomReady },
    { event: "context-menu", listener: handleDevToolsContextMenu },
    { event: "contextmenu", listener: handleDevToolsContextMenu },
    { event: "focus", listener: handleGuestInteraction },
    { event: "ipc-message", listener: handleGuestInteractionIpcMessage }
  ];
  for (const record of records) {
    webview.addEventListener(record.event, record.listener);
  }
  entry.attachedListeners = records;
}

function resolveBrowserNodeContextMenuPoint(
  event: Event,
  webview: BrowserNodeWebviewTag
): BrowserNodeWebviewContextMenuPoint {
  const eventWithPoint = event as Event & {
    clientX?: unknown;
    clientY?: unknown;
    params?: { x?: unknown; y?: unknown };
  };
  const clientX = readFiniteNumber(eventWithPoint.clientX);
  const clientY = readFiniteNumber(eventWithPoint.clientY);
  if (clientX !== null && clientY !== null) {
    return { x: clientX, y: clientY };
  }

  const paramX = readFiniteNumber(eventWithPoint.params?.x);
  const paramY = readFiniteNumber(eventWithPoint.params?.y);
  if (paramX !== null && paramY !== null) {
    return { x: paramX, y: paramY };
  }

  const rect = webview.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top
  };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBrowserNodeWebContentsId(
  webview: BrowserNodeWebviewTag | null
): number | null {
  let webContentsId: number | undefined;
  try {
    webContentsId = webview?.getWebContentsId?.();
  } catch {
    return null;
  }
  return typeof webContentsId === "number" && Number.isFinite(webContentsId)
    ? webContentsId
    : null;
}

function reportBrowserNodeWebviewDiagnostic(
  entry: BrowserNodeWebviewControllerEntry,
  event: string,
  details: Record<string, unknown>,
  level: "debug" | "info" | "warn" | "error" = "info"
): void {
  try {
    entry.context.feature.reportDiagnostic?.({
      details: {
        ...details,
        nodeId: entry.context.nodeId
      },
      event,
      level
    });
  } catch {
    // Diagnostics must never affect BrowserNode lifecycle.
  }
}
