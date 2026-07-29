import type { BrowserWindow } from "electron";
import { resolveBrowserSessionPartition } from "../core/session.ts";
import type { BrowserNodeLoopbackPreviewRoutingOptions } from "./loopbackPreview.ts";
import { createBrowserNodeLoopbackPreviewProxy } from "./loopbackPreviewProxy.ts";
import type {
  BrowserNodeActivationInput,
  BrowserNodeCancelChromeCookieImportInput,
  BrowserNodeChromeCookieImportInput,
  BrowserNodeChromeProfileDiscoveryResult,
  BrowserNodeSaveScreenshotInput,
  BrowserNodeSetDeviceEmulationInput,
  BrowserNodeDownloadActionInput,
  BrowserNodeFindInPageInput,
  BrowserNodeGuestOpenUrlInput,
  BrowserNodeNavigateInput,
  BrowserNodeNodeIdInput,
  BrowserNodeOpenExternalInput,
  BrowserNodePrepareSessionInput,
  BrowserNodeRegisterGuestInput,
  BrowserNodeScreenshotSaveResult,
  BrowserNodeSetZoomFactorInput,
  BrowserNodeShowDevToolsContextMenuInput,
  BrowserNodeStopFindInPageInput,
  BrowserNodeUnregisterGuestInput,
  BrowserNodeUpdateAutomationTargetInput
} from "../core/types.ts";
import type { BrowserNodeAutomationTargetRegistry } from "./automationTypes.ts";
import { createBrowserGuestManager } from "./guestManager.ts";
import type {
  BrowserGuestManager,
  BrowserPreferredColorScheme,
  BrowserGuestWebContents,
  BrowserNodeElectronLogger,
  BrowserNodeScreenshotCapture
} from "./types.ts";

export interface BrowserNodeElectronMainChannels {
  readonly activate: string;
  readonly capturePreview?: string;
  readonly chooseDownloadDirectory?: string;
  readonly clearBrowsingData?: string;
  readonly cancelChromeCookieImport?: string;
  readonly close: string;
  readonly debugDump?: string;
  readonly event: string;
  readonly findInPage?: string;
  readonly discoverChromeCookieProfiles?: string;
  readonly importChromeCookies?: string;
  readonly importCookies?: string;
  readonly goBack: string;
  readonly goForward: string;
  readonly guestOpenUrl?: string;
  readonly navigate: string;
  readonly openDevTools?: string;
  readonly openExternal?: string;
  readonly performDownloadAction?: string;
  readonly prepareSession: string;
  readonly printPage?: string;
  readonly registerGuest: string;
  readonly reload: string;
  readonly saveScreenshot?: string;
  readonly setDeviceEmulation?: string;
  readonly setZoomFactor?: string;
  readonly showDevToolsContextMenu?: string;
  readonly stopFindInPage?: string;
  readonly unregisterGuest: string;
  readonly updateAutomationTarget?: string;
}

export interface BrowserNodeElectronDevToolsContextMenuInput {
  readonly label: string;
  readonly openDevTools: () => Promise<void> | void;
  readonly ownerWindow: BrowserWindow;
  readonly point: { x: number; y: number };
}

export interface BrowserNodeElectronScreenshotSaveInput extends BrowserNodeScreenshotCapture {
  readonly ownerWindow: BrowserWindow;
}

export interface RegisterBrowserNodeElectronMainInput {
  readonly automationRegistry?: BrowserNodeAutomationTargetRegistry;
  readonly channels: BrowserNodeElectronMainChannels;
  readonly chooseDownloadDirectory?: (
    ownerWindow: BrowserWindow
  ) => Promise<string | null>;
  readonly getOwnerWindow: (event: unknown) => BrowserWindow | null;
  readonly getPreferredColorScheme?: () => BrowserPreferredColorScheme;
  readonly discoverChromeCookieProfiles?: () => Promise<BrowserNodeChromeProfileDiscoveryResult>;
  readonly logger?: BrowserNodeElectronLogger;
  readonly loopbackPreviewRouting?: BrowserNodeLoopbackPreviewRoutingOptions;
  readonly openDownloadedFile?: (path: string) => Promise<void> | void;
  readonly notifyCookieImportResult?: (input: {
    ownerWindow: BrowserWindow;
    result: import("../core/types.ts").BrowserNodeCookieImportResult;
    source: "chrome" | "file";
  }) => void;
  readonly openExternal: (url: string) => Promise<void> | void;
  readonly prepareSession?: (
    input: BrowserNodePrepareSessionInput
  ) => Promise<void> | void;
  readonly prepareChromeCookieImport?: (
    profileId: import("../core/types.ts").BrowserNodeChromeProfileId,
    signal: AbortSignal
  ) => Promise<import("./types.ts").BrowserNodeChromeCookiePreparationResult>;
  readonly registerHandler: <TPayload, TResult>(
    channel: string,
    handler: (event: unknown, payload: TPayload) => Promise<TResult> | TResult
  ) => void;
  readonly registerListener?: <TPayload>(
    channel: string,
    handler: (event: unknown, payload: TPayload) => void
  ) => void;
  readonly resolveWebContents: (input: {
    event: unknown;
    ownerWindow: BrowserWindow;
    webContentsId: number;
  }) => BrowserGuestWebContents | null;
  readonly saveScreenshot?: (
    input: BrowserNodeElectronScreenshotSaveInput
  ) => Promise<BrowserNodeScreenshotSaveResult>;
  readonly selectCookieImport?: (
    ownerWindow: BrowserWindow
  ) => Promise<import("./types.ts").BrowserNodeCookieImportSource | null>;
  readonly showDevToolsContextMenu?: (
    input: BrowserNodeElectronDevToolsContextMenuInput
  ) => Promise<void> | void;
  readonly showDownloadedFile?: (path: string) => Promise<void> | void;
  readonly syncPreferredColorScheme?: (
    contents: BrowserGuestWebContents,
    scheme: BrowserPreferredColorScheme
  ) => Promise<void> | void;
  readonly subscribePreferredColorScheme?: (
    listener: (scheme: BrowserPreferredColorScheme) => void
  ) => () => void;
}

export function registerBrowserNodeElectronMain(
  input: RegisterBrowserNodeElectronMainInput
): void {
  const managersByWindow = new WeakMap<BrowserWindow, BrowserGuestManager>();
  const managers = new Set<BrowserGuestManager>();
  const chromeImports = new WeakMap<
    BrowserGuestManager,
    Map<string, AbortController>
  >();
  const loopbackPreviewProxy =
    input.loopbackPreviewRouting !== undefined
      ? createBrowserNodeLoopbackPreviewProxy({
          logger: input.logger,
          resolveSession: async ({
            profileId,
            sessionMode,
            sessionPartition
          }) => {
            const { session } = await import("electron");
            return session.fromPartition(
              resolveBrowserSessionPartition({
                profileId,
                sessionMode,
                sessionPartition
              })
            );
          },
          routing: input.loopbackPreviewRouting
        })
      : null;

  const resolveManagerForWindow = (
    event: unknown,
    ownerWindow: BrowserWindow
  ): BrowserGuestManager => {
    const existing = managersByWindow.get(ownerWindow);
    if (existing) {
      return existing;
    }

    const manager = createBrowserGuestManager({
      automationRegistry: input.automationRegistry,
      chooseDownloadDirectory: input.chooseDownloadDirectory
        ? () =>
            input.chooseDownloadDirectory?.(ownerWindow) ??
            Promise.resolve(null)
        : undefined,
      emit(browserEvent) {
        if (!ownerWindow.isDestroyed()) {
          ownerWindow.webContents.send(input.channels.event, browserEvent);
        }
      },
      getPreferredColorScheme: input.getPreferredColorScheme,
      logger: input.logger,
      openDownloadedFile: input.openDownloadedFile,
      openExternal: input.openExternal,
      prepareSession:
        loopbackPreviewProxy !== null || input.prepareSession
          ? async (payload) => {
              await input.prepareSession?.(payload);
              await loopbackPreviewProxy?.configureSession(payload);
            }
          : undefined,
      prepareChromeCookieImport: input.prepareChromeCookieImport,
      async resolveOrdinaryCookieSession({
        profileId,
        sessionMode,
        sessionPartition
      }) {
        if (sessionMode === "incognito" || sessionPartition !== null) {
          return null;
        }
        const { session } = await import("electron");
        return session.fromPartition(
          resolveBrowserSessionPartition({
            profileId,
            sessionMode,
            sessionPartition
          })
        );
      },
      async resolveOrdinaryCookieStore({
        profileId,
        sessionMode,
        sessionPartition
      }) {
        if (sessionMode === "incognito" || sessionPartition !== null) {
          return null;
        }
        const { session } = await import("electron");
        return (
          session.fromPartition(
            resolveBrowserSessionPartition({
              profileId,
              sessionMode,
              sessionPartition
            })
          ).cookies ?? null
        );
      },
      resolveWebContents: (webContentsId) =>
        input.resolveWebContents({
          event,
          ownerWindow,
          webContentsId
        }),
      saveScreenshot: input.saveScreenshot
        ? (payload) =>
            input.saveScreenshot?.({ ...payload, ownerWindow }) ??
            Promise.resolve({ filePath: null, saved: false })
        : undefined,
      selectCookieImport: input.selectCookieImport
        ? () => input.selectCookieImport?.(ownerWindow) ?? Promise.resolve(null)
        : undefined,
      showDownloadedFile: input.showDownloadedFile,
      syncPreferredColorScheme: input.syncPreferredColorScheme,
      subscribePreferredColorScheme: input.subscribePreferredColorScheme
    });
    ownerWindow.once("closed", () => {
      manager.dispose();
      managers.delete(manager);
      managersByWindow.delete(ownerWindow);
    });
    managers.add(manager);
    managersByWindow.set(ownerWindow, manager);
    return manager;
  };

  const resolveOwnedManager = (event: unknown) => {
    const ownerWindow = input.getOwnerWindow(event);
    if (!ownerWindow) {
      throw new Error("Browser Node IPC requires an owner window");
    }
    return {
      manager: resolveManagerForWindow(event, ownerWindow),
      ownerWindow
    };
  };

  const showDevToolsContextMenu =
    input.showDevToolsContextMenu ?? showElectronDevToolsContextMenu;

  const refreshCookieImportSession = (
    target: import("./types.ts").BrowserGuestElectronSession | null,
    result: import("../core/types.ts").BrowserNodeCookieImportResult
  ): void => {
    // Refresh only real navigable pages. Reloading blank/home guests (or doing a
    // broad session refresh while the home UI is visible) races with URL sync and
    // produces a visible flash / workspace update storm.
    if (!target || result.imported === 0) {
      return;
    }
    for (const manager of managers) {
      manager.reloadCookieImportSession(target);
    }
  };

  input.registerHandler(input.channels.prepareSession, (event, payload) =>
    resolveOwnedManager(event).manager.prepareSession(
      payload as BrowserNodePrepareSessionInput
    )
  );
  input.registerHandler(input.channels.activate, (event, payload) =>
    resolveOwnedManager(event).manager.activate(
      payload as BrowserNodeActivationInput
    )
  );
  if (input.channels.clearBrowsingData) {
    input.registerHandler(input.channels.clearBrowsingData, (event, payload) =>
      resolveOwnedManager(event).manager.clearBrowsingData(
        payload as BrowserNodeNodeIdInput
      )
    );
  }
  if (input.channels.capturePreview) {
    input.registerHandler(input.channels.capturePreview, (event, payload) =>
      resolveOwnedManager(event).manager.capturePreview(
        payload as BrowserNodeNodeIdInput
      )
    );
  }
  if (input.channels.chooseDownloadDirectory) {
    input.registerHandler(
      input.channels.chooseDownloadDirectory,
      (event, payload) =>
        resolveOwnedManager(event).manager.chooseDownloadDirectory(
          payload as BrowserNodeNodeIdInput
        )
    );
  }
  input.registerHandler(input.channels.registerGuest, (event, payload) =>
    resolveOwnedManager(event).manager.registerGuest(
      payload as BrowserNodeRegisterGuestInput
    )
  );
  if (input.channels.findInPage) {
    input.registerHandler(input.channels.findInPage, (event, payload) =>
      resolveOwnedManager(event).manager.findInPage(
        payload as BrowserNodeFindInPageInput
      )
    );
  }
  if (input.channels.importCookies) {
    input.registerHandler(
      input.channels.importCookies,
      async (event, payload) => {
        const { manager, ownerWindow } = resolveOwnedManager(event);
        const nodeInput = payload as BrowserNodeNodeIdInput;
        const result = await manager.importCookies(nodeInput);
        const target = await manager.resolveCookieImportSession(nodeInput);
        refreshCookieImportSession(target, result);
        input.notifyCookieImportResult?.({
          ownerWindow,
          result,
          source: "file"
        });
        return result;
      }
    );
  }
  if (
    input.channels.discoverChromeCookieProfiles &&
    input.discoverChromeCookieProfiles
  ) {
    input.registerHandler(
      input.channels.discoverChromeCookieProfiles,
      (event) => {
        resolveOwnedManager(event);
        return input.discoverChromeCookieProfiles!();
      }
    );
  }
  if (input.channels.importChromeCookies && input.prepareChromeCookieImport) {
    input.registerHandler(
      input.channels.importChromeCookies,
      async (event, payload) => {
        const { manager, ownerWindow } = resolveOwnedManager(event);
        const chromeInput = payload as BrowserNodeChromeCookieImportInput;
        const imports = chromeImports.get(manager) ?? new Map();
        chromeImports.set(manager, imports);
        if (!chromeInput.operationId || imports.has(chromeInput.operationId)) {
          return invalidChromeImportOperation();
        }
        const controller = new AbortController();
        imports.set(chromeInput.operationId, controller);
        let result;
        try {
          result = await manager.importChromeCookies(
            chromeInput,
            controller.signal
          );
        } finally {
          imports.delete(chromeInput.operationId);
        }
        const target = await manager.resolveCookieImportSession(chromeInput);
        refreshCookieImportSession(target, result);
        input.notifyCookieImportResult?.({
          ownerWindow,
          result,
          source: "chrome"
        });
        return result;
      }
    );
  }
  if (input.channels.cancelChromeCookieImport) {
    input.registerHandler(
      input.channels.cancelChromeCookieImport,
      (event, payload) => {
        const { manager } = resolveOwnedManager(event);
        const cancelInput = payload as BrowserNodeCancelChromeCookieImportInput;
        chromeImports.get(manager)?.get(cancelInput.operationId)?.abort();
      }
    );
  }
  input.registerHandler(input.channels.unregisterGuest, (event, payload) =>
    resolveOwnedManager(event).manager.unregisterGuest(
      payload as BrowserNodeUnregisterGuestInput
    )
  );
  if (input.channels.updateAutomationTarget) {
    input.registerHandler(
      input.channels.updateAutomationTarget,
      (event, payload) => {
        const normalized = payload as BrowserNodeUpdateAutomationTargetInput;
        resolveOwnedManager(event).manager.updateAutomationTarget(
          normalized.nodeId,
          normalized.automationTarget
        );
      }
    );
  }
  input.registerHandler(input.channels.navigate, (event, payload) =>
    resolveOwnedManager(event).manager.navigate(
      payload as BrowserNodeNavigateInput
    )
  );
  if (input.channels.openExternal) {
    input.registerHandler(input.channels.openExternal, (event, payload) =>
      resolveOwnedManager(event).manager.openExternal(
        payload as BrowserNodeOpenExternalInput
      )
    );
  }
  if (input.channels.openDevTools) {
    input.registerHandler(input.channels.openDevTools, (event, payload) => {
      const nodePayload = payload as BrowserNodeNodeIdInput;
      return resolveOwnedManager(event).manager.openDevTools(nodePayload);
    });
  }
  if (input.channels.performDownloadAction) {
    input.registerHandler(
      input.channels.performDownloadAction,
      (event, payload) =>
        resolveOwnedManager(event).manager.performDownloadAction(
          payload as BrowserNodeDownloadActionInput
        )
    );
  }
  if (input.channels.printPage) {
    input.registerHandler(input.channels.printPage, (event, payload) =>
      resolveOwnedManager(event).manager.printPage(
        payload as BrowserNodeNodeIdInput
      )
    );
  }
  if (input.channels.showDevToolsContextMenu) {
    input.registerHandler(
      input.channels.showDevToolsContextMenu,
      (event, payload) => {
        const contextMenuPayload =
          payload as BrowserNodeShowDevToolsContextMenuInput;
        const { manager, ownerWindow } = resolveOwnedManager(event);
        return showDevToolsContextMenu({
          label: contextMenuPayload.label,
          openDevTools: () => {
            return manager.openDevTools({ nodeId: contextMenuPayload.nodeId });
          },
          ownerWindow,
          point: contextMenuPayload.point
        });
      }
    );
  }
  input.registerHandler(input.channels.goBack, (event, payload) =>
    resolveOwnedManager(event).manager.goBack(payload as BrowserNodeNodeIdInput)
  );
  input.registerHandler(input.channels.goForward, (event, payload) =>
    resolveOwnedManager(event).manager.goForward(
      payload as BrowserNodeNodeIdInput
    )
  );
  input.registerHandler(input.channels.reload, (event, payload) =>
    resolveOwnedManager(event).manager.reload(payload as BrowserNodeNodeIdInput)
  );
  if (input.channels.saveScreenshot) {
    input.registerHandler(input.channels.saveScreenshot, (event, payload) =>
      resolveOwnedManager(event).manager.saveScreenshot(
        payload as BrowserNodeSaveScreenshotInput
      )
    );
  }
  if (input.channels.setDeviceEmulation) {
    input.registerHandler(input.channels.setDeviceEmulation, (event, payload) =>
      resolveOwnedManager(event).manager.setDeviceEmulation(
        payload as BrowserNodeSetDeviceEmulationInput
      )
    );
  }
  if (input.channels.setZoomFactor) {
    input.registerHandler(input.channels.setZoomFactor, (event, payload) =>
      resolveOwnedManager(event).manager.setZoomFactor(
        payload as BrowserNodeSetZoomFactorInput
      )
    );
  }
  if (input.channels.stopFindInPage) {
    input.registerHandler(input.channels.stopFindInPage, (event, payload) =>
      resolveOwnedManager(event).manager.stopFindInPage(
        payload as BrowserNodeStopFindInPageInput
      )
    );
  }
  input.registerHandler(input.channels.close, (event, payload) =>
    resolveOwnedManager(event).manager.close(payload as BrowserNodeNodeIdInput)
  );
  if (input.channels.debugDump) {
    input.registerHandler(input.channels.debugDump, (event, payload) =>
      resolveOwnedManager(event).manager.debugDump(
        payload as BrowserNodeNodeIdInput
      )
    );
  }
  if (input.channels.guestOpenUrl && input.registerListener) {
    input.registerListener(input.channels.guestOpenUrl, (event, payload) => {
      const senderId = readBrowserNodeIpcSenderId(event);
      const openUrlPayload = payload as BrowserNodeGuestOpenUrlInput | null;
      if (
        typeof senderId !== "number" ||
        !Number.isFinite(senderId) ||
        !openUrlPayload ||
        typeof openUrlPayload.url !== "string"
      ) {
        return;
      }
      resolveOwnedManager(event).manager.handleGuestOpenUrl(
        senderId,
        openUrlPayload
      );
    });
  }
}

async function showElectronDevToolsContextMenu(
  input: BrowserNodeElectronDevToolsContextMenuInput
): Promise<void> {
  const { Menu } = await import("electron");
  const menu = Menu.buildFromTemplate([
    {
      click: () => {
        void Promise.resolve(input.openDevTools()).catch(() => undefined);
      },
      label: input.label
    }
  ]);
  menu.popup({
    window: input.ownerWindow,
    x: Math.round(input.point.x),
    y: Math.round(input.point.y)
  });
}

function readBrowserNodeIpcSenderId(event: unknown): number | null {
  const sender = (event as { sender?: { id?: unknown } } | null)?.sender;
  return typeof sender?.id === "number" ? sender.id : null;
}

function invalidChromeImportOperation(): import("../core/types.ts").BrowserNodeCookieImportResult {
  return {
    canceled: false,
    failed: 0,
    failureCode: "invalid-operation",
    failureStage: "profile",
    imported: 0,
    partial: false,
    skipped: 0,
    status: "failed"
  };
}
