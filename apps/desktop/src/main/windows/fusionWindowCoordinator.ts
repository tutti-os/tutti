import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, screen } from "electron";
import {
  desktopFusionDockLayout,
  type DesktopFusionDockSearchScope,
  type DesktopFusionOpenWindowInput,
  type DesktopFusionState,
  type DesktopFusionUpdateWindowInput,
  type DesktopFusionWindowDescriptor,
  type DesktopFusionWindowTargetInput
} from "../../shared/contracts/fusion.ts";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import { awaitWorkspaceWindowReady } from "../host/workspaceWindowReady.ts";
import {
  createEmptyFusionBusinessWindowBoundsState,
  readFusionBusinessWindowBounds,
  resolveFusionBusinessWindowBounds,
  resolveFusionBusinessWindowMinimumSize,
  toFusionBusinessWindowIdentity,
  writeFusionBusinessWindowBounds,
  type FusionBusinessWindowDisplay,
  type FusionBusinessWindowSize,
  type PersistedFusionBusinessWindowBoundsState
} from "./fusionBusinessWindowBounds.ts";
import { ensureFusionBusinessWindowCreation } from "./fusionBusinessWindowCreation.ts";
import {
  createFusionBusinessWindowBoundsStore,
  type FusionBusinessWindowBoundsStore
} from "./fusionBusinessWindowBoundsStore.ts";
import {
  createWorkspaceWindow,
  installDesktopRendererWindowNavigationPolicy,
  loadAgentWindowContent,
  loadFusionDockWindowContent,
  loadFusionToolWindowContent,
  registerWorkspaceWindowCommandCloseHandler
} from "./workspaceWindow.ts";
import { createFusionWindowLoadMetadata } from "./fusionWindowLoadMetadata.ts";
import {
  resolveFusionDockBounds,
  resolveFusionDockWidthTransition,
  type FusionDockDisplay,
  type PersistedFusionDockBounds
} from "./fusionDockBounds.ts";
import { createFusionDockWindowOptions } from "./fusionDockWindowOptions.ts";
import {
  createFusionDockBoundsStore,
  type FusionDockBoundsStore
} from "./fusionDockBoundsStore.ts";
import {
  resolveFusionDockShortcutAction,
  resolveFusionDockVisibilityPreferenceAction
} from "./fusionDockVisibility.ts";
import { FusionWindowRegistry } from "./fusionWindowRegistry.ts";
import { toElectronGlobalShortcutAccelerator } from "./fusionGlobalShortcut.ts";
import {
  createFusionTrayController,
  type FusionTrayController
} from "./fusionTrayController.ts";
import { fusionWorkspaceRequiresDockReload } from "./fusionWorkspaceBoundary.ts";
import type {
  CreateFusionWindowCoordinatorOptions,
  DesktopFusionRendererAccessContext,
  DesktopFusionWindowCoordinator
} from "./fusionWindowCoordinatorTypes.ts";

export type {
  CreateFusionWindowCoordinatorOptions,
  DesktopFusionRendererAccessContext,
  DesktopFusionWindowCoordinator,
  FusionDockVisibilityMode
} from "./fusionWindowCoordinatorTypes.ts";

interface FusionWindowLaunchRecord extends DesktopFusionOpenWindowInput {
  windowInstanceId: string;
}

const fusionDockDefaultHeightPx = desktopFusionDockLayout.heightPx;
const fusionDockDefaultWidthPx = desktopFusionDockLayout.collapsedWindowWidthPx;
const fusionDockSearchWidthPx = desktopFusionDockLayout.searchWindowWidthPx;
const fusionDockWorkAreaMarginPx = 20;
const fusionWindowDefaultWidthPx = 1100;
const fusionWindowDefaultHeightPx = 760;

export function createFusionWindowCoordinator(
  options: CreateFusionWindowCoordinatorOptions
): DesktopFusionWindowCoordinator {
  return new ElectronFusionWindowCoordinator(options);
}

class ElectronFusionWindowCoordinator implements DesktopFusionWindowCoordinator {
  readonly #options: CreateFusionWindowCoordinatorOptions;
  readonly #registry = new FusionWindowRegistry({
    createID: () => randomUUID(),
    now: () => Date.now()
  });
  readonly #nativeWindows = new Map<string, BrowserWindow>();
  readonly #businessWindowCreations = new Map<string, Promise<BrowserWindow>>();
  readonly #businessWindowMinimumSizes = new Map<
    string,
    FusionBusinessWindowSize
  >();
  readonly #launchRecords = new Map<string, FusionWindowLaunchRecord>();
  readonly #businessWindowBoundsStore: FusionBusinessWindowBoundsStore;
  readonly #dockBoundsStore: FusionDockBoundsStore;
  readonly #tray: FusionTrayController;
  #businessWindowBoundsState = createEmptyFusionBusinessWindowBoundsState();
  #businessWindowBoundsLoaded = false;
  #businessWindowBoundsLoadPromise: Promise<void> | null = null;
  #businessWindowBoundsWriteTimer: ReturnType<typeof setTimeout> | null = null;
  #dockWindow: BrowserWindow | null = null;
  #dockWindowPromise: Promise<BrowserWindow> | null = null;
  #workspaceId: string | null = null;
  #revision = 0;
  #shortcutBinding: string | null = null;
  #shortcutError: DesktopFusionState["shortcut"]["error"] = null;
  #registeredAccelerator: string | null = null;
  #dockBoundsWriteTimer: ReturnType<typeof setTimeout> | null = null;
  #dockAutoHideTimer: ReturnType<typeof setTimeout> | null = null;
  #dockSearchExpanded = false;
  #dockSearchScope: DesktopFusionDockSearchScope = "all";
  #displayListenersInstalled = false;
  #preferencesUnsubscribe: (() => void) | null = null;
  #disposing = false;

  constructor(options: CreateFusionWindowCoordinatorOptions) {
    this.#options = options;
    const userDataPath = options.userDataPath ?? app.getPath("userData");
    this.#businessWindowBoundsStore = createFusionBusinessWindowBoundsStore(
      join(userDataPath, "fusion-business-window-bounds.json")
    );
    this.#dockBoundsStore = createFusionDockBoundsStore(
      join(userDataPath, "fusion-dock-bounds.json")
    );
    this.#tray = createFusionTrayController({
      getLocale: options.getLocale,
      onBackgroundTasks: () => void this.showDockSearch("background-tasks"),
      onNewWindow: (kind, workspaceId) => {
        void this.openWindow({ forceNew: true, kind, workspaceId });
      },
      onOpenSettings: (workspaceId) => {
        void this.openWindow({ kind: "settings", workspaceId });
      },
      onQuit: () => app.quit(),
      onShowDock: () => void this.showDock(),
      onToggleDock: () => void this.toggleDock(),
      trayIconPath: options.trayIconPath
    });
  }

  isActive(): boolean {
    return this.#options.active;
  }

  async start(workspaceId: string): Promise<void> {
    if (!this.isActive()) {
      return;
    }
    const nextWorkspaceId = requireText(workspaceId, "workspaceId");
    if (fusionWorkspaceRequiresDockReload(this.#workspaceId, nextWorkspaceId)) {
      await this.#destroyDockForWorkspaceSwitch();
    }
    this.#workspaceId = nextWorkspaceId;
    this.#installDisplayListeners();
    this.#preferencesUnsubscribe ??=
      this.#options.subscribePreferences?.(this.#handlePreferencesChanged) ??
      null;
    this.#tray.ensure(this.#workspaceId);
    this.#registerGlobalShortcut();
    await this.#ensureDockWindow();
    if (this.#options.getDockVisibilityMode() === "shortcut-only") {
      await this.hideDock();
    } else {
      await this.showDock();
    }
    this.#publishState();
  }

  getState(): DesktopFusionState {
    return this.#createState(this.#workspaceId, true);
  }

  getStateForWorkspace(workspaceId: string): DesktopFusionState {
    return this.#createState(requireText(workspaceId, "workspaceId"), false);
  }

  getWindowDescriptor(
    windowInstanceId: string
  ): DesktopFusionWindowDescriptor | null {
    return this.#registry.find(windowInstanceId);
  }

  async activatePrimarySurface(): Promise<void> {
    this.#assertActive();
    const mostRecentWindow = this.#registry.list()[0];
    if (mostRecentWindow) {
      await this.focusWindow({
        windowInstanceId: mostRecentWindow.windowInstanceId
      });
      return;
    }
    await this.showDock();
  }

  getRendererAccessContext(
    webContentsId: number
  ): DesktopFusionRendererAccessContext | null {
    if (
      this.#workspaceId &&
      this.#dockWindow &&
      !this.#dockWindow.isDestroyed() &&
      !this.#dockWindow.webContents.isDestroyed() &&
      this.#dockWindow.webContents.id === webContentsId
    ) {
      return { kind: "dock", workspaceId: this.#workspaceId };
    }
    for (const [windowInstanceId, target] of this.#nativeWindows) {
      if (
        target.isDestroyed() ||
        target.webContents.isDestroyed() ||
        target.webContents.id !== webContentsId
      ) {
        continue;
      }
      const descriptor = this.#registry.find(windowInstanceId);
      return descriptor
        ? {
            kind: "window",
            windowInstanceId,
            workspaceId: descriptor.workspaceId
          }
        : null;
    }
    return null;
  }

  #createState(
    workspaceId: string | null,
    includeAllWindows: boolean
  ): DesktopFusionState {
    return {
      active: this.isActive(),
      dockSearchExpanded:
        workspaceId === this.#workspaceId && this.#dockSearchExpanded,
      dockSearchScope:
        workspaceId === this.#workspaceId ? this.#dockSearchScope : "all",
      dockVisible:
        workspaceId === this.#workspaceId &&
        this.#dockWindow !== null &&
        !this.#dockWindow.isDestroyed() &&
        this.#dockWindow.isVisible(),
      revision: this.#revision,
      shortcut: {
        binding: this.#shortcutBinding,
        error: this.#shortcutError
      },
      windows: includeAllWindows
        ? this.#registry.list()
        : workspaceId
          ? this.#registry.listForWorkspace(workspaceId)
          : [],
      workspaceId
    };
  }

  async showDock(): Promise<void> {
    if (!this.isActive() || !this.#workspaceId || this.#disposing) {
      return;
    }
    this.#clearDockAutoHide();
    const dockWindow = await this.#ensureDockWindow();
    if (dockWindow.isDestroyed()) {
      return;
    }
    dockWindow.show();
    dockWindow.focus();
    this.#publishState();
  }

  async showDockSearch(
    scope: DesktopFusionDockSearchScope = "all"
  ): Promise<void> {
    this.#setDockSearchExpanded(true, scope);
    await this.showDock();
  }

  async hideDock(): Promise<void> {
    this.#clearDockAutoHide();
    this.#setDockSearchExpanded(false, "all");
    if (this.#dockWindow && !this.#dockWindow.isDestroyed()) {
      this.#dockWindow.hide();
      this.#publishState();
    }
  }

  async toggleDock(): Promise<void> {
    if (this.#dockWindow?.isVisible()) {
      await this.hideDock();
      return;
    }
    await this.showDock();
  }

  async openWindow(
    input: DesktopFusionOpenWindowInput
  ): Promise<DesktopFusionWindowDescriptor> {
    this.#assertActive();
    const normalizedInput = normalizeOpenWindowInput(input);
    const reusable = this.#registry.findReusable(normalizedInput);
    if (reusable) {
      await this.focusWindow({ windowInstanceId: reusable.windowInstanceId });
      return this.#registry.find(reusable.windowInstanceId) ?? reusable;
    }

    const descriptor = this.#registry.create(normalizedInput);
    this.#launchRecords.set(descriptor.windowInstanceId, {
      ...normalizedInput,
      windowInstanceId: descriptor.windowInstanceId
    });
    this.#publishState();
    await this.#ensureBusinessWindow(descriptor);
    return this.#registry.find(descriptor.windowInstanceId) ?? descriptor;
  }

  async focusWindow(input: DesktopFusionWindowTargetInput): Promise<void> {
    this.#assertActive();
    const descriptor = this.#registry.find(input.windowInstanceId);
    if (!descriptor) {
      return;
    }
    let target = this.#nativeWindows.get(descriptor.windowInstanceId) ?? null;
    if (
      this.#businessWindowCreations.has(descriptor.windowInstanceId) ||
      !target ||
      target.isDestroyed()
    ) {
      target = await this.#ensureBusinessWindow(descriptor);
    }
    if (target.isMinimized()) {
      target.restore();
    }
    target.show();
    target.focus();
    this.#registry.markFocused(descriptor.windowInstanceId);
    this.#publishState();
  }

  async closeWindow(input: DesktopFusionWindowTargetInput): Promise<void> {
    this.#assertActive();
    const target = this.#nativeWindows.get(input.windowInstanceId);
    if (target && !target.isDestroyed()) {
      target.close();
    }
  }

  async flushPersistentState(): Promise<void> {
    if (this.#dockBoundsWriteTimer) {
      clearTimeout(this.#dockBoundsWriteTimer);
      this.#dockBoundsWriteTimer = null;
    }
    if (this.#businessWindowBoundsWriteTimer) {
      clearTimeout(this.#businessWindowBoundsWriteTimer);
      this.#businessWindowBoundsWriteTimer = null;
    }
    for (const [windowInstanceId, window] of this.#nativeWindows) {
      if (!window.isDestroyed()) {
        this.#captureBusinessWindowBounds(windowInstanceId, window);
      }
    }
    await Promise.all([
      this.#persistCurrentDockBounds(),
      this.#persistBusinessWindowBounds()
    ]);
  }

  async updateWindow(
    input: DesktopFusionUpdateWindowInput
  ): Promise<DesktopFusionWindowDescriptor> {
    this.#assertActive();
    const descriptor = this.#registry.update(input);
    if (!descriptor) {
      throw new Error("Fusion window is unavailable");
    }
    const launchRecord = this.#launchRecords.get(input.windowInstanceId);
    if (launchRecord) {
      this.#launchRecords.set(input.windowInstanceId, {
        ...launchRecord,
        ...(input.resourceId === undefined
          ? {}
          : { resourceId: input.resourceId }),
        ...(input.title === undefined ? {} : { title: input.title })
      });
    }
    const target = this.#nativeWindows.get(input.windowInstanceId);
    if (target && !target.isDestroyed() && descriptor.title) {
      target.setTitle(descriptor.title);
    }
    if (input.resourceId !== undefined && target && !target.isDestroyed()) {
      this.#captureBusinessWindowBounds(input.windowInstanceId, target);
      this.#scheduleBusinessWindowBoundsWrite();
    }
    this.#publishState();
    return descriptor;
  }

  dispose(): void {
    if (this.#disposing) {
      return;
    }
    this.#disposing = true;
    this.#clearDockAutoHide();
    if (this.#businessWindowBoundsWriteTimer) {
      clearTimeout(this.#businessWindowBoundsWriteTimer);
      this.#businessWindowBoundsWriteTimer = null;
    }
    if (this.#dockBoundsWriteTimer) {
      clearTimeout(this.#dockBoundsWriteTimer);
      this.#dockBoundsWriteTimer = null;
    }
    if (this.#registeredAccelerator) {
      globalShortcut.unregister(this.#registeredAccelerator);
      this.#registeredAccelerator = null;
    }
    this.#removeDisplayListeners();
    this.#preferencesUnsubscribe?.();
    this.#preferencesUnsubscribe = null;
    this.#tray.dispose();
    for (const [windowInstanceId, window] of this.#nativeWindows) {
      if (!window.isDestroyed()) {
        this.#captureBusinessWindowBounds(windowInstanceId, window);
        window.destroy();
      }
    }
    void this.#persistCurrentDockBounds();
    void this.#persistBusinessWindowBounds();
    this.#businessWindowCreations.clear();
    this.#businessWindowMinimumSizes.clear();
    this.#nativeWindows.clear();
    if (this.#dockWindow && !this.#dockWindow.isDestroyed()) {
      this.#dockWindow.destroy();
    }
    this.#dockWindow = null;
    this.#registry.clear();
    this.#launchRecords.clear();
  }

  async #ensureDockWindow(): Promise<BrowserWindow> {
    if (this.#dockWindow && !this.#dockWindow.isDestroyed()) {
      this.#reconcileDockWindowWidth(this.#dockWindow, false);
      return this.#dockWindow;
    }
    if (this.#dockWindowPromise) {
      return this.#dockWindowPromise;
    }

    this.#dockWindowPromise = this.#createDockWindow().finally(() => {
      this.#dockWindowPromise = null;
    });
    return this.#dockWindowPromise;
  }

  async #destroyDockForWorkspaceSwitch(): Promise<void> {
    if (this.#dockWindowPromise) {
      try {
        await this.#dockWindowPromise;
      } catch (error) {
        this.#options.logger.warn(
          "failed to finish the previous Fusion Dock before workspace switch",
          { error: error instanceof Error ? error.message : String(error) }
        );
      }
    }
    const dockWindow = this.#dockWindow;
    if (this.#dockBoundsWriteTimer) {
      clearTimeout(this.#dockBoundsWriteTimer);
      this.#dockBoundsWriteTimer = null;
    }
    await this.#persistCurrentDockBounds();
    if (dockWindow && !dockWindow.isDestroyed()) {
      dockWindow.destroy();
    }
    if (this.#dockWindow === dockWindow) {
      this.#dockWindow = null;
    }
    this.#dockSearchExpanded = false;
    this.#dockSearchScope = "all";
  }

  async #createDockWindow(): Promise<BrowserWindow> {
    const persisted = await this.#dockBoundsStore.read();
    const bounds = resolveFusionDockBounds({
      defaultHeight: fusionDockDefaultHeightPx,
      defaultWidth: this.#dockSearchExpanded
        ? fusionDockSearchWidthPx
        : fusionDockDefaultWidthPx,
      displays: screen.getAllDisplays().map(toFusionDockDisplay),
      margin: fusionDockWorkAreaMarginPx,
      persisted,
      primaryDisplay: toFusionDockDisplay(screen.getPrimaryDisplay())
    });
    const dockWindow = new BrowserWindow(
      createFusionDockWindowOptions({
        bounds,
        preloadPath: this.#options.preloadPath
      })
    );
    installDesktopRendererWindowNavigationPolicy(
      dockWindow,
      this.#options.logger
    );
    this.#dockWindow = dockWindow;
    dockWindow.setAlwaysOnTop(true, "floating");
    dockWindow.setFullScreenable(false);
    dockWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    dockWindow.setWindowButtonVisibility(false);
    if (process.platform === "darwin") {
      dockWindow.setHiddenInMissionControl(true);
      dockWindow.excludedFromShownWindowsMenu = true;
    }
    const unregisterCommandClose = registerWorkspaceWindowCommandCloseHandler(
      dockWindow,
      () => void this.hideDock()
    );
    dockWindow.on("move", () => this.#scheduleDockBoundsWrite());
    dockWindow.on("blur", () => {
      this.#setDockSearchExpanded(false, "all");
      this.#scheduleDockAutoHide();
    });
    dockWindow.on("focus", () => this.#clearDockAutoHide());
    dockWindow.on("show", () => this.#publishState());
    dockWindow.on("hide", () => this.#publishState());
    dockWindow.once("closed", () => {
      unregisterCommandClose();
      if (this.#dockWindow === dockWindow) {
        this.#dockWindow = null;
      }
      this.#publishState();
    });
    dockWindow.webContents.once("did-finish-load", () => {
      void dockWindow.webContents
        .insertCSS(
          "body{ -webkit-app-region:drag; } button,input,textarea,select,a,[data-fusion-no-drag]{ -webkit-app-region:no-drag; }"
        )
        .catch(() => undefined);
    });
    await awaitWorkspaceWindowReady(
      dockWindow,
      () => {
        loadFusionDockWindowContent(dockWindow, {
          dockPlacement: this.#options.getDockPlacement(),
          locale: this.#options.getLocale(),
          rendererUrl: this.#options.rendererUrl,
          theme: this.#options.getTheme(),
          workspaceID: this.#workspaceId ?? ""
        });
      },
      { maximizeOnShow: false, showOnReady: false }
    );
    return dockWindow;
  }

  async #createBusinessWindow(
    descriptor: DesktopFusionWindowDescriptor
  ): Promise<BrowserWindow> {
    const launchRecord = this.#launchRecords.get(descriptor.windowInstanceId);
    if (!launchRecord) {
      throw new Error("Fusion window launch metadata is unavailable");
    }
    await this.#ensureBusinessWindowBoundsLoaded();
    if (this.#disposing) {
      throw new Error("Fusion window coordinator is disposing");
    }
    const target = createWorkspaceWindow({
      browserNodeGuestPreloadPath: this.#options.browserNodeGuestPreloadPath,
      closeFromCommandShortcutNatively: true,
      enableDevelopmentReloadShortcut:
        this.#options.enableDevelopmentReloadShortcut === true,
      locale: this.#options.getLocale(),
      preloadPath: this.#options.preloadPath,
      rendererUrl: this.#options.rendererUrl,
      theme: this.#options.getTheme(),
      windowChrome: "native",
      windowKind: descriptor.kind === "agent" ? "agent" : "fusion-tool",
      workspaceAppPreloadPath: this.#options.workspaceAppPreloadPath,
      workspaceID: descriptor.workspaceId
    });
    const minimumSize = target.getMinimumSize();
    this.#businessWindowMinimumSizes.set(descriptor.windowInstanceId, {
      height: minimumSize[1] ?? 1,
      width: minimumSize[0] ?? 1
    });
    if (process.platform === "darwin") {
      target.setHiddenInMissionControl(false);
      target.excludedFromShownWindowsMenu = false;
    }
    if (descriptor.kind !== "agent") {
      target.setBounds({
        ...target.getBounds(),
        height: fusionWindowDefaultHeightPx,
        width: fusionWindowDefaultWidthPx
      });
    }
    const defaultBounds = target.getBounds();
    const persistedBounds = readFusionBusinessWindowBounds(
      this.#businessWindowBoundsState,
      toFusionBusinessWindowIdentity(descriptor)
    );
    const resolvedBounds = resolveFusionBusinessWindowBounds({
      cascade: launchRecord.forceNew === true,
      defaultBounds,
      displays: screen.getAllDisplays().map(toFusionBusinessWindowDisplay),
      occupiedBounds: [...this.#nativeWindows.values()]
        .filter((window) => !window.isDestroyed())
        .map((window) => window.getNormalBounds()),
      persisted: persistedBounds,
      primaryDisplay: toFusionBusinessWindowDisplay(screen.getPrimaryDisplay())
    });
    this.#applyBusinessWindowBounds(
      descriptor.windowInstanceId,
      target,
      resolvedBounds
    );
    if (descriptor.title) {
      target.setTitle(descriptor.title);
    }
    this.#nativeWindows.set(descriptor.windowInstanceId, target);
    this.#connectBusinessWindow(descriptor.windowInstanceId, target);
    await awaitWorkspaceWindowReady(
      target,
      () => this.#loadBusinessWindow(target, descriptor, launchRecord),
      { maximizeOnShow: false }
    );
    if (target.isDestroyed()) {
      throw new Error("Fusion window closed during creation");
    }
    return target;
  }

  #ensureBusinessWindow(
    descriptor: DesktopFusionWindowDescriptor
  ): Promise<BrowserWindow> {
    const inFlight = this.#businessWindowCreations.get(
      descriptor.windowInstanceId
    );
    if (inFlight) {
      return inFlight;
    }
    const current = this.#nativeWindows.get(descriptor.windowInstanceId);
    if (current && !current.isDestroyed()) {
      return Promise.resolve(current);
    }
    return ensureFusionBusinessWindowCreation({
      create: async () => {
        try {
          return await this.#createBusinessWindow(descriptor);
        } catch (error) {
          const failedWindow = this.#nativeWindows.get(
            descriptor.windowInstanceId
          );
          this.#nativeWindows.delete(descriptor.windowInstanceId);
          this.#businessWindowMinimumSizes.delete(descriptor.windowInstanceId);
          if (failedWindow && !failedWindow.isDestroyed()) {
            failedWindow.destroy();
          }
          this.#registry.remove(descriptor.windowInstanceId);
          this.#launchRecords.delete(descriptor.windowInstanceId);
          this.#publishState();
          throw error;
        }
      },
      inFlight: this.#businessWindowCreations,
      windowInstanceId: descriptor.windowInstanceId
    });
  }

  #loadBusinessWindow(
    target: BrowserWindow,
    descriptor: DesktopFusionWindowDescriptor,
    launchRecord: FusionWindowLaunchRecord
  ): void {
    const common = {
      dockPlacement: this.#options.getDockPlacement(),
      locale: this.#options.getLocale(),
      rendererUrl: this.#options.rendererUrl,
      theme: this.#options.getTheme(),
      workspaceID: descriptor.workspaceId
    };
    const loadMetadata = createFusionWindowLoadMetadata(
      descriptor,
      launchRecord.launchPayload
    );
    if (descriptor.kind === "agent") {
      loadAgentWindowContent(target, {
        ...common,
        ...loadMetadata
      });
      return;
    }
    loadFusionToolWindowContent(target, {
      ...common,
      fusionWindowKind: descriptor.kind,
      ...loadMetadata
    });
  }

  #connectBusinessWindow(
    windowInstanceId: string,
    target: BrowserWindow
  ): void {
    const updateVisibility = (
      visibility: "hidden" | "minimized" | "visible"
    ) => {
      this.#registry.setVisibility(windowInstanceId, visibility);
      this.#publishState();
    };
    target.on("focus", () => {
      this.#registry.markFocused(windowInstanceId);
      this.#publishState();
    });
    target.on("blur", () => {
      this.#registry.markUnfocused(windowInstanceId);
      this.#publishState();
    });
    target.on("show", () => updateVisibility("visible"));
    target.on("hide", () => updateVisibility("hidden"));
    target.on("minimize", () => updateVisibility("minimized"));
    target.on("restore", () => {
      updateVisibility("visible");
      this.#restoreBusinessWindowToAvailableDisplay(windowInstanceId, target);
    });
    target.on("move", () => {
      this.#captureBusinessWindowBounds(windowInstanceId, target);
      this.#scheduleBusinessWindowBoundsWrite();
    });
    target.on("resize", () => {
      this.#captureBusinessWindowBounds(windowInstanceId, target);
      this.#scheduleBusinessWindowBoundsWrite();
    });
    target.on("unmaximize", () => {
      this.#restoreBusinessWindowToAvailableDisplay(windowInstanceId, target);
    });
    target.on("leave-full-screen", () => {
      this.#restoreBusinessWindowToAvailableDisplay(windowInstanceId, target);
    });
    target.on("close", () => {
      this.#captureBusinessWindowBounds(windowInstanceId, target);
      void this.#persistBusinessWindowBounds();
    });
    target.webContents.on("page-title-updated", (_event, title) => {
      if (title.trim()) {
        this.#registry.update({ title, windowInstanceId });
        this.#publishState();
      }
    });
    target.once("closed", () => {
      this.#nativeWindows.delete(windowInstanceId);
      this.#businessWindowMinimumSizes.delete(windowInstanceId);
      if (this.#disposing) {
        this.#registry.remove(windowInstanceId);
      } else {
        this.#registry.remove(windowInstanceId);
        this.#launchRecords.delete(windowInstanceId);
      }
      this.#publishState();
    });
  }

  #registerGlobalShortcut(): void {
    if (this.#registeredAccelerator) {
      globalShortcut.unregister(this.#registeredAccelerator);
      this.#registeredAccelerator = null;
    }
    const configuredBinding = this.#options.getShortcutBinding();
    if (configuredBinding === null) {
      this.#shortcutBinding = null;
      this.#shortcutError = null;
      this.#publishState();
      return;
    }
    const binding = configuredBinding.trim();
    this.#shortcutBinding = binding;
    const accelerator = toElectronGlobalShortcutAccelerator(binding);
    if (!accelerator) {
      this.#shortcutError = "invalid";
      this.#publishState();
      return;
    }
    try {
      const registered = globalShortcut.register(accelerator, () => {
        void this.#toggleDockSearch();
      });
      if (!registered) {
        this.#shortcutError = "conflict";
        this.#publishState();
        return;
      }
      this.#registeredAccelerator = accelerator;
      this.#shortcutError = null;
    } catch (error) {
      this.#shortcutError = "invalid";
      this.#options.logger.warn("failed to register Fusion Dock shortcut", {
        binding,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    this.#publishState();
  }

  #publishState(): void {
    this.#revision += 1;
    this.#sendState(this.#dockWindow, this.getState());
    const statesByWorkspace = new Map<string, DesktopFusionState>();
    for (const [windowInstanceId, target] of this.#nativeWindows) {
      const descriptor = this.#registry.find(windowInstanceId);
      if (!descriptor) {
        continue;
      }
      let state = statesByWorkspace.get(descriptor.workspaceId);
      if (!state) {
        state = this.getStateForWorkspace(descriptor.workspaceId);
        statesByWorkspace.set(descriptor.workspaceId, state);
      }
      this.#sendState(target, state);
    }
    this.#tray.refresh(this.#workspaceId);
  }

  #sendState(target: BrowserWindow | null, state: DesktopFusionState): void {
    if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
      target.webContents.send(desktopIpcChannels.fusion.state, state);
    }
  }

  async #toggleDockSearch(): Promise<void> {
    const action = resolveFusionDockShortcutAction({
      dockSearchExpanded: this.#dockSearchExpanded,
      dockVisible: this.#dockWindow?.isVisible() === true
    });
    if (action === "hide") {
      await this.hideDock();
      return;
    }
    await this.showDockSearch("all");
  }

  #setDockSearchExpanded(
    expanded: boolean,
    scope: DesktopFusionDockSearchScope
  ): void {
    const expansionChanged = this.#dockSearchExpanded !== expanded;
    if (!expansionChanged && this.#dockSearchScope === scope) {
      return;
    }
    this.#dockSearchExpanded = expanded;
    this.#dockSearchScope = scope;
    const dockWindow = this.#dockWindow;
    if (expansionChanged && dockWindow && !dockWindow.isDestroyed()) {
      this.#reconcileDockWindowWidth(dockWindow, true);
    }
    this.#publishState();
  }

  #reconcileDockWindowWidth(dockWindow: BrowserWindow, animate: boolean): void {
    const currentBounds = dockWindow.getBounds();
    const targetWidth = this.#dockSearchExpanded
      ? fusionDockSearchWidthPx
      : fusionDockDefaultWidthPx;
    if (currentBounds.width === targetWidth) {
      return;
    }
    const display = screen.getDisplayMatching(currentBounds);
    dockWindow.setBounds(
      resolveFusionDockWidthTransition({
        bounds: currentBounds,
        targetWidth,
        workArea: display.workArea
      }),
      animate
    );
    this.#scheduleDockBoundsWrite();
  }

  #scheduleDockAutoHide(): void {
    const mode = this.#options.getDockVisibilityMode();
    if (mode === "always") {
      return;
    }
    this.#clearDockAutoHide();
    this.#dockAutoHideTimer = setTimeout(() => {
      this.#dockAutoHideTimer = null;
      void this.hideDock();
    }, 180);
  }

  #clearDockAutoHide(): void {
    if (this.#dockAutoHideTimer) {
      clearTimeout(this.#dockAutoHideTimer);
      this.#dockAutoHideTimer = null;
    }
  }

  #scheduleDockBoundsWrite(): void {
    if (this.#dockBoundsWriteTimer) {
      clearTimeout(this.#dockBoundsWriteTimer);
    }
    this.#dockBoundsWriteTimer = setTimeout(() => {
      this.#dockBoundsWriteTimer = null;
      const bounds = this.#readCurrentDockBounds();
      if (!bounds) {
        return;
      }
      void this.#persistDockBounds(bounds);
    }, 250);
  }

  #readCurrentDockBounds(): PersistedFusionDockBounds | null {
    if (!this.#dockWindow || this.#dockWindow.isDestroyed()) {
      return null;
    }
    const bounds = this.#dockWindow.getBounds();
    return {
      ...bounds,
      displayId: screen.getDisplayMatching(bounds).id
    };
  }

  #persistCurrentDockBounds(): Promise<void> {
    const bounds = this.#readCurrentDockBounds();
    return bounds ? this.#persistDockBounds(bounds) : Promise.resolve();
  }

  #persistDockBounds(bounds: PersistedFusionDockBounds): Promise<void> {
    return this.#dockBoundsStore.write(bounds).catch((error: unknown) => {
      this.#options.logger.warn("failed to persist Fusion Dock bounds", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async #ensureBusinessWindowBoundsLoaded(): Promise<void> {
    if (this.#businessWindowBoundsLoaded) {
      return;
    }
    this.#businessWindowBoundsLoadPromise ??= this.#businessWindowBoundsStore
      .read()
      .then((state) => {
        this.#businessWindowBoundsState =
          state ?? createEmptyFusionBusinessWindowBoundsState();
        this.#businessWindowBoundsLoaded = true;
      })
      .finally(() => {
        this.#businessWindowBoundsLoadPromise = null;
      });
    await this.#businessWindowBoundsLoadPromise;
  }

  #captureBusinessWindowBounds(
    windowInstanceId: string,
    target: BrowserWindow
  ): void {
    if (!this.#businessWindowBoundsLoaded || target.isDestroyed()) {
      return;
    }
    const descriptor = this.#registry.find(windowInstanceId);
    if (!descriptor) {
      return;
    }
    const bounds = target.getNormalBounds();
    this.#businessWindowBoundsState = writeFusionBusinessWindowBounds(
      this.#businessWindowBoundsState,
      toFusionBusinessWindowIdentity(descriptor),
      {
        ...bounds,
        displayId: screen.getDisplayMatching(bounds).id,
        updatedAtUnixMs: Date.now()
      }
    );
  }

  #scheduleBusinessWindowBoundsWrite(): void {
    if (this.#businessWindowBoundsWriteTimer) {
      clearTimeout(this.#businessWindowBoundsWriteTimer);
    }
    this.#businessWindowBoundsWriteTimer = setTimeout(() => {
      this.#businessWindowBoundsWriteTimer = null;
      void this.#persistBusinessWindowBounds();
    }, 250);
  }

  #persistBusinessWindowBounds(): Promise<void> {
    if (!this.#businessWindowBoundsLoaded) {
      return Promise.resolve();
    }
    const snapshot: PersistedFusionBusinessWindowBoundsState = {
      entries: { ...this.#businessWindowBoundsState.entries },
      version: 1
    };
    return this.#businessWindowBoundsStore
      .write(snapshot)
      .catch((error: unknown) => {
        this.#options.logger.warn(
          "failed to persist Fusion business window bounds",
          { error: error instanceof Error ? error.message : String(error) }
        );
      });
  }

  #restoreBusinessWindowToAvailableDisplay(
    windowInstanceId: string,
    target: BrowserWindow
  ): void {
    if (
      target.isDestroyed() ||
      target.isFullScreen() ||
      target.isMaximized() ||
      target.isMinimized()
    ) {
      return;
    }
    const descriptor = this.#registry.find(windowInstanceId);
    if (!descriptor) {
      return;
    }
    const currentBounds = target.getNormalBounds();
    const savedBounds = readFusionBusinessWindowBounds(
      this.#businessWindowBoundsState,
      toFusionBusinessWindowIdentity(descriptor)
    );
    const resolvedBounds = resolveFusionBusinessWindowBounds({
      defaultBounds: currentBounds,
      displays: screen.getAllDisplays().map(toFusionBusinessWindowDisplay),
      persisted: savedBounds ?? {
        ...currentBounds,
        displayId: screen.getDisplayMatching(currentBounds).id,
        updatedAtUnixMs: Date.now()
      },
      primaryDisplay: toFusionBusinessWindowDisplay(screen.getPrimaryDisplay())
    });
    this.#applyBusinessWindowBounds(windowInstanceId, target, resolvedBounds);
    this.#captureBusinessWindowBounds(windowInstanceId, target);
  }

  #applyBusinessWindowBounds(
    windowInstanceId: string,
    target: BrowserWindow,
    bounds: ReturnType<typeof resolveFusionBusinessWindowBounds>
  ): void {
    const display =
      screen
        .getAllDisplays()
        .find((candidate) => candidate.id === bounds.displayId) ??
      screen.getPrimaryDisplay();
    const configuredMinimum =
      this.#businessWindowMinimumSizes.get(windowInstanceId);
    if (configuredMinimum) {
      const minimum = resolveFusionBusinessWindowMinimumSize({
        configured: configuredMinimum,
        workArea: display.workArea
      });
      target.setMinimumSize(minimum.width, minimum.height);
    }
    const { displayId: _displayId, ...windowBounds } = bounds;
    if (!sameWindowBounds(target.getNormalBounds(), windowBounds)) {
      target.setBounds(windowBounds);
    }
  }

  #installDisplayListeners(): void {
    if (this.#displayListenersInstalled) {
      return;
    }
    this.#displayListenersInstalled = true;
    screen.on("display-added", this.#handleDisplaysChanged);
    screen.on("display-removed", this.#handleDisplaysChanged);
    screen.on("display-metrics-changed", this.#handleDisplaysChanged);
  }

  #removeDisplayListeners(): void {
    if (!this.#displayListenersInstalled) {
      return;
    }
    this.#displayListenersInstalled = false;
    screen.off("display-added", this.#handleDisplaysChanged);
    screen.off("display-removed", this.#handleDisplaysChanged);
    screen.off("display-metrics-changed", this.#handleDisplaysChanged);
  }

  readonly #handleDisplaysChanged = (): void => {
    const persisted = this.#readCurrentDockBounds();
    if (persisted && this.#dockWindow && !this.#dockWindow.isDestroyed()) {
      const bounds = resolveFusionDockBounds({
        defaultHeight: fusionDockDefaultHeightPx,
        defaultWidth: this.#dockSearchExpanded
          ? fusionDockSearchWidthPx
          : fusionDockDefaultWidthPx,
        displays: screen.getAllDisplays().map(toFusionDockDisplay),
        margin: fusionDockWorkAreaMarginPx,
        persisted,
        primaryDisplay: toFusionDockDisplay(screen.getPrimaryDisplay())
      });
      this.#dockWindow.setBounds(bounds);
      this.#scheduleDockBoundsWrite();
    }
    for (const [windowInstanceId, target] of this.#nativeWindows) {
      this.#restoreBusinessWindowToAvailableDisplay(windowInstanceId, target);
    }
    void this.#persistBusinessWindowBounds();
  };

  readonly #handlePreferencesChanged = (): void => {
    if (!this.isActive() || this.#disposing) {
      return;
    }
    this.#registerGlobalShortcut();
    const action = resolveFusionDockVisibilityPreferenceAction({
      dockFocused: this.#dockWindow?.isFocused() === true,
      dockVisible: this.#dockWindow?.isVisible() === true,
      mode: this.#options.getDockVisibilityMode()
    });
    if (action === "hide") {
      void this.hideDock();
    } else if (action === "show") {
      void this.showDock();
    } else if (action === "schedule-auto-hide") {
      this.#scheduleDockAutoHide();
    }
    this.#tray.refresh(this.#workspaceId);
  };

  #assertActive(): void {
    if (!this.isActive()) {
      throw new Error("Fusion Mode is not active");
    }
  }
}

function normalizeOpenWindowInput(
  input: DesktopFusionOpenWindowInput
): DesktopFusionOpenWindowInput {
  return {
    ...input,
    resourceId: readOptionalString(input.resourceId),
    title: readOptionalString(input.title),
    workspaceId: requireText(input.workspaceId, "workspaceId")
  };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toFusionDockDisplay(display: Electron.Display): FusionDockDisplay {
  return { id: display.id, workArea: display.workArea };
}

function toFusionBusinessWindowDisplay(
  display: Electron.Display
): FusionBusinessWindowDisplay {
  return { id: display.id, workArea: display.workArea };
}

function sameWindowBounds(
  left: Electron.Rectangle,
  right: Electron.Rectangle
): boolean {
  return (
    left.height === right.height &&
    left.width === right.width &&
    left.x === right.x &&
    left.y === right.y
  );
}
