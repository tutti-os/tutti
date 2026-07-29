import type {
  BrowserNodeActivationInput,
  BrowserNodeAutomationTargetMetadata,
  BrowserNodeChromeCookieImportInput,
  BrowserNodeChromeProfileId,
  BrowserNodeCookieImportResult,
  BrowserNodeDebugDump,
  BrowserNodeDownloadDirectoryResult,
  BrowserNodeEvent,
  BrowserNodeGuestOpenUrlInput,
  BrowserNodeFindInPageInput,
  BrowserNodeDownloadActionInput,
  BrowserNodeNavigateInput,
  BrowserNodeNodeIdInput,
  BrowserNodeOpenExternalInput,
  BrowserNodePrepareSessionInput,
  BrowserNodeRegisterGuestInput,
  BrowserNodeScreenshotSaveResult,
  BrowserNodeSaveScreenshotInput,
  BrowserNodeSessionMode,
  BrowserNodeSetDeviceEmulationInput,
  BrowserNodeSetZoomFactorInput,
  BrowserNodeShowDevToolsContextMenuInput,
  BrowserNodeStopFindInPageInput,
  BrowserNodeUnregisterGuestInput
} from "../core/types.ts";
import type { BrowserNodeAutomationTargetRegistry } from "./automationTypes.ts";

export interface BrowserGuestManager {
  activate(input: BrowserNodeActivationInput): Promise<void>;
  chooseDownloadDirectory(
    input: BrowserNodeNodeIdInput
  ): Promise<BrowserNodeDownloadDirectoryResult>;
  clearBrowsingData(input: BrowserNodeNodeIdInput): Promise<void>;
  capturePreview(input: BrowserNodeNodeIdInput): Promise<string | null>;
  close(input: BrowserNodeNodeIdInput): Promise<void>;
  debugDump(input: BrowserNodeNodeIdInput): BrowserNodeDebugDump | null;
  dispose(): void;
  goBack(input: BrowserNodeNodeIdInput): Promise<void>;
  goForward(input: BrowserNodeNodeIdInput): Promise<void>;
  findInPage(input: BrowserNodeFindInPageInput): Promise<void>;
  importCookies(
    input: BrowserNodeNodeIdInput
  ): Promise<BrowserNodeCookieImportResult>;
  importChromeCookies(
    input: BrowserNodeChromeCookieImportInput,
    signal: AbortSignal
  ): Promise<BrowserNodeCookieImportResult>;
  getCookieImportSession(
    input: BrowserNodeNodeIdInput
  ): BrowserGuestElectronSession | null;
  resolveCookieImportSession(
    input: BrowserNodeNodeIdInput
  ): Promise<BrowserGuestElectronSession | null>;
  reloadCookieImportSession(target: BrowserGuestElectronSession): void;
  handleGuestOpenUrl(
    webContentsId: number,
    input: BrowserNodeGuestOpenUrlInput
  ): void;
  navigate(input: BrowserNodeNavigateInput): Promise<void>;
  openDevTools(input: BrowserNodeNodeIdInput): Promise<void>;
  openExternal(input: BrowserNodeOpenExternalInput): Promise<void>;
  performDownloadAction(input: BrowserNodeDownloadActionInput): Promise<void>;
  prepareSession(input: BrowserNodePrepareSessionInput): Promise<void>;
  printPage(input: BrowserNodeNodeIdInput): Promise<void>;
  registerGuest(input: BrowserNodeRegisterGuestInput): Promise<void>;
  reload(input: BrowserNodeNodeIdInput): Promise<void>;
  saveScreenshot(
    input: BrowserNodeSaveScreenshotInput
  ): Promise<BrowserNodeScreenshotSaveResult>;
  setDeviceEmulation(input: BrowserNodeSetDeviceEmulationInput): Promise<void>;
  setZoomFactor(input: BrowserNodeSetZoomFactorInput): Promise<void>;
  stopFindInPage(input: BrowserNodeStopFindInPageInput): Promise<void>;
  unregisterGuest(input: BrowserNodeUnregisterGuestInput): Promise<void>;
  updateAutomationTarget(
    nodeId: string,
    metadata: BrowserNodeAutomationTargetMetadata
  ): void;
}

export type BrowserNodeShowDevToolsContextMenuPayload =
  BrowserNodeShowDevToolsContextMenuInput;

export type BrowserPreferredColorScheme = "dark" | "light";

export interface BrowserGuestManagerInput {
  automationRegistry?: BrowserNodeAutomationTargetRegistry;
  emit: (event: BrowserNodeEvent) => void;
  getPreferredColorScheme?: () => BrowserPreferredColorScheme;
  chooseDownloadDirectory?: () => Promise<string | null>;
  selectCookieImport?: () => Promise<BrowserNodeCookieImportSource | null>;
  prepareChromeCookieImport?: (
    profileId: BrowserNodeChromeProfileId,
    signal: AbortSignal
  ) => Promise<BrowserNodeChromeCookiePreparationResult>;
  logger?: BrowserNodeElectronLogger;
  openExternal: (url: string) => Promise<void> | void;
  openDownloadedFile?: (path: string) => Promise<void> | void;
  prepareSession?: (
    input: BrowserNodePrepareSessionInput
  ) => Promise<void> | void;
  resolveOrdinaryCookieStore?: (input: {
    profileId: string | null;
    sessionMode: BrowserNodeSessionMode;
    sessionPartition: string | null;
  }) =>
    | Promise<BrowserGuestCookieStore | null>
    | BrowserGuestCookieStore
    | null;
  resolveOrdinaryCookieSession?: (input: {
    profileId: string | null;
    sessionMode: BrowserNodeSessionMode;
    sessionPartition: string | null;
  }) =>
    | Promise<BrowserGuestElectronSession | null>
    | BrowserGuestElectronSession
    | null;
  resolveWebContents: (webContentsId: number) => BrowserGuestWebContents | null;
  saveScreenshot?: (
    input: BrowserNodeScreenshotCapture
  ) => Promise<BrowserNodeScreenshotSaveResult>;
  showDownloadedFile?: (path: string) => Promise<void> | void;
  syncPreferredColorScheme?: (
    contents: BrowserGuestWebContents,
    scheme: BrowserPreferredColorScheme
  ) => Promise<void> | void;
  subscribePreferredColorScheme?: (
    listener: (scheme: BrowserPreferredColorScheme) => void
  ) => () => void;
}

export interface BrowserNodeElectronLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
}

export interface BrowserGuestWindowOpenHandlerResponse {
  action: "allow" | "deny";
  outlivesOpener?: boolean;
  overrideBrowserWindowOptions?: Record<string, unknown>;
}

export interface BrowserGuestWebContents {
  readonly id?: number;
  readonly session?: BrowserGuestElectronSession;
  readonly debugger?: BrowserGuestDebugger;
  zoomFactor?: number;
  readonly navigationHistory?: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
  };
  canGoBack(): boolean;
  canGoForward(): boolean;
  capturePage?(): Promise<BrowserGuestNativeImage>;
  disableDeviceEmulation?(): void;
  enableDeviceEmulation?(
    parameters: BrowserGuestDeviceEmulationParameters
  ): void;
  findInPage?(text: string, options?: BrowserGuestFindInPageOptions): number;
  getTitle(): string;
  getURL(): string;
  getUserAgent?(): string;
  goBack(): void;
  goForward(): void;
  isDestroyed(): boolean;
  isLoading(): boolean;
  loadURL(url: string): Promise<void>;
  off(event: string, listener: (...args: unknown[]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  openDevTools?(options?: BrowserGuestOpenDevToolsOptions): void;
  print?(
    options: Record<string, unknown>,
    callback: (success: boolean, failureReason: string) => void
  ): void;
  reload(): void;
  setUserAgent?(userAgent: string): void;
  setWindowOpenHandler?(
    handler: (details: { url: string }) => BrowserGuestWindowOpenHandlerResponse
  ): void;
  stopFindInPage?(
    action: "clearSelection" | "keepSelection" | "activateSelection"
  ): void;
}

export interface BrowserGuestFindInPageOptions {
  findNext?: boolean;
  forward?: boolean;
  matchCase?: boolean;
}

export interface BrowserGuestElectronSession {
  clearCache?(): Promise<void>;
  clearStorageData?(): Promise<void>;
  cookies?: BrowserGuestCookieStore;
  off(event: "will-download", listener: BrowserGuestWillDownloadListener): this;
  on(event: "will-download", listener: BrowserGuestWillDownloadListener): this;
  resolveHost?(
    hostname: string,
    options?: { cacheUsage?: "allowed" | "disallowed" | "staleAllowed" }
  ): Promise<{ endpoints: readonly { address: string }[] }>;
  setDownloadPath?(path: string): void;
}

export interface BrowserGuestCookieStore {
  flushStore?(): Promise<void>;
  set(details: BrowserGuestCookieDetails): Promise<void>;
}

export interface BrowserGuestCookieDetails {
  domain?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  name: string;
  path?: string;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  secure?: boolean;
  url: string;
  value: string;
}

export type BrowserNodeChromeCookiePreparationResult =
  | {
      status: "canceled";
    }
  | {
      cookies: readonly BrowserGuestCookieDetails[];
      skipped: number;
      status: "ready";
    }
  | {
      failureCode: string;
      failureStage: import("../core/types.ts").BrowserNodeCookieImportFailureStage;
      status: "failed";
    };

export interface BrowserGuestDebugger {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  off?(
    event: "message",
    listener: (event: unknown, method: string, params: unknown) => void
  ): this;
  on?(
    event: "message",
    listener: (event: unknown, method: string, params: unknown) => void
  ): this;
  sendCommand(
    method: string,
    commandParams?: Record<string, unknown>
  ): Promise<unknown>;
}

export interface BrowserGuestDeviceEmulationParameters {
  deviceScaleFactor: number;
  screenPosition: "desktop" | "mobile";
  screenSize: { height: number; width: number };
  scale: number;
  viewPosition?: { x: number; y: number };
  viewSize: { height: number; width: number };
}

export type BrowserGuestDownloadItemState =
  | "progressing"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface BrowserGuestDownloadItem {
  canResume(): boolean;
  cancel(): void;
  getFilename(): string;
  getReceivedBytes(): number;
  getSavePath(): string;
  getState(): BrowserGuestDownloadItemState;
  getTotalBytes(): number;
  getURL(): string;
  isPaused(): boolean;
  off(event: string, listener: (...args: unknown[]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  pause(): void;
  resume(): void;
}

export type BrowserGuestWillDownloadListener = (
  event: unknown,
  item: BrowserGuestDownloadItem,
  webContents: BrowserGuestWebContents
) => void;

export interface BrowserNodeScreenshotCapture {
  dataUrl: string;
  suggestedFileName: string;
}

export interface BrowserNodeCookieImportSource {
  contents: string;
  fileName: string;
}

export interface BrowserGuestOpenDevToolsOptions {
  activate?: boolean;
  mode: "left" | "right" | "bottom" | "undocked" | "detach";
}

export interface BrowserGuestNativeImage {
  getSize?(): { height: number; width: number };
  isEmpty?(): boolean;
  resize?(options: {
    height?: number;
    quality?: "best" | "good" | "better" | "nearest";
    width?: number;
  }): BrowserGuestNativeImage;
  toDataURL(): string;
}
