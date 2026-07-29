export type BrowserNodeSessionMode = "shared" | "incognito" | "profile";

export type BrowserNodeLifecycle = "active" | "cold";

export interface BrowserNodeSameOriginNavigationPolicy {
  readonly mode: "same-origin";
  readonly originUrl: string;
}

export type BrowserNodeNavigationPolicy = BrowserNodeSameOriginNavigationPolicy;

export type BrowserNodeErrorCode =
  | "invalid-url"
  | "navigation-failed"
  | "unsupported-protocol"
  | "unsupported-url";

export type BrowserNodeErrorParams = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface BrowserNodeRuntimeError {
  code: BrowserNodeErrorCode;
  diagnosticMessage?: string;
  params?: BrowserNodeErrorParams;
}

export interface BrowserNodeRuntimeState {
  canGoBack: boolean;
  canGoForward: boolean;
  downloads: readonly BrowserNodeDownloadState[];
  error: BrowserNodeRuntimeError | null;
  findResult: BrowserNodeFindResult | null;
  isAttachedToWindow: boolean;
  isLoading: boolean;
  isOccluded: boolean;
  lifecycle: BrowserNodeLifecycle;
  title: string | null;
  url: string | null;
  zoomFactor: number;
}

export interface BrowserNodeStateEvent {
  type: "state";
  nodeId: string;
  lifecycle: BrowserNodeLifecycle;
  isOccluded: boolean;
  isAttachedToWindow?: boolean;
  url: string | null;
  title: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor?: number;
}

export interface BrowserNodeFindResult {
  activeMatchOrdinal: number;
  finalUpdate: boolean;
  matches: number;
  query: string;
}

export interface BrowserNodeFindResultEvent extends BrowserNodeFindResult {
  nodeId: string;
  type: "find-result";
}

export type BrowserNodeDownloadStatus =
  | "progressing"
  | "paused"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface BrowserNodeDownloadState {
  canResume: boolean;
  fileName: string;
  filePath: string | null;
  id: string;
  receivedBytes: number;
  status: BrowserNodeDownloadStatus;
  totalBytes: number;
  url: string;
}

export interface BrowserNodeDownloadEvent {
  download: BrowserNodeDownloadState;
  nodeId: string;
  type: "download";
}

export interface BrowserNodeClosedEvent {
  type: "closed";
  nodeId: string;
}

export interface BrowserNodeErrorEvent {
  type: "error";
  nodeId: string;
  code: BrowserNodeErrorCode;
  diagnosticMessage?: string;
  params?: BrowserNodeErrorParams;
}

export interface BrowserNodeOpenUrlEvent {
  type: "open-url";
  sourceNodeId: string;
  url: string;
  reuseIfOpen?: boolean;
  title?: string;
}

export type BrowserNodeEvent =
  | BrowserNodeStateEvent
  | BrowserNodeClosedEvent
  | BrowserNodeErrorEvent
  | BrowserNodeOpenUrlEvent
  | BrowserNodeFindResultEvent
  | BrowserNodeDownloadEvent;

export interface BrowserNodeActivationInput {
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition?: string | null;
  url: string;
}

export interface BrowserNodePrepareSessionInput {
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition?: string | null;
  url?: string;
}

export interface BrowserNodeRegisterGuestInput {
  automationTarget?: BrowserNodeAutomationTargetMetadata | null;
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition?: string | null;
  url?: string;
  webContentsId: number;
}

export type BrowserNodeAutomationSurfaceRole = "agent" | "user";

export interface BrowserNodeAutomationTargetMetadata {
  agentSessionId?: string | null;
  focused?: boolean;
  selected: boolean;
  surfaceId: string;
  surfaceRole: BrowserNodeAutomationSurfaceRole;
  tabId: string | null;
  workspaceId: string;
}

export interface BrowserNodeUpdateAutomationTargetInput extends BrowserNodeNodeIdInput {
  automationTarget: BrowserNodeAutomationTargetMetadata;
}

export interface BrowserNodeUnregisterGuestInput {
  nodeId: string;
  webContentsId: number;
}

export interface BrowserNodeNavigateInput {
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  url: string;
}

export interface BrowserNodeOpenExternalInput {
  url: string;
}

export interface BrowserNodeGuestOpenUrlInput {
  url: string;
}

export interface BrowserNodeContextMenuPoint {
  x: number;
  y: number;
}

export interface BrowserNodeShowDevToolsContextMenuInput {
  label: string;
  nodeId: string;
  point: BrowserNodeContextMenuPoint;
}

export interface BrowserNodeNodeIdInput {
  nodeId: string;
}

export interface BrowserNodeFindInPageInput extends BrowserNodeNodeIdInput {
  findNext?: boolean;
  forward?: boolean;
  text: string;
}

export interface BrowserNodeStopFindInPageInput extends BrowserNodeNodeIdInput {
  action?: "clearSelection" | "keepSelection" | "activateSelection";
}

export interface BrowserNodeSetZoomFactorInput extends BrowserNodeNodeIdInput {
  zoomFactor: number;
}

export type BrowserNodeDevicePreset =
  | "desktop"
  | "iphone-14"
  | "pixel-7"
  | "ipad-air";

export interface BrowserNodeSetDeviceEmulationInput extends BrowserNodeNodeIdInput {
  preset: BrowserNodeDevicePreset;
}

export type BrowserNodeScreenshotMode = "visible" | "full-page";

export interface BrowserNodeSaveScreenshotInput extends BrowserNodeNodeIdInput {
  mode: BrowserNodeScreenshotMode;
}

export type BrowserNodeCookieImportFailureStage =
  | "profile"
  | "snapshot"
  | "keychain"
  | "database"
  | "decrypt"
  | "integrity";

interface BrowserNodeCookieImportCounts {
  failed: number;
  imported: number;
  partial: boolean;
  skipped: number;
}

export type BrowserNodeCookieImportResult =
  | (BrowserNodeCookieImportCounts & {
      canceled: true;
      status: "canceled";
    })
  | (BrowserNodeCookieImportCounts & {
      canceled: false;
      status: "completed";
    })
  | (BrowserNodeCookieImportCounts & {
      canceled: false;
      failureCode: string;
      failureStage: BrowserNodeCookieImportFailureStage;
      status: "failed";
    });

declare const browserNodeChromeProfileIdBrand: unique symbol;
export type BrowserNodeChromeProfileId = string & {
  readonly [browserNodeChromeProfileIdBrand]: true;
};

export interface BrowserNodeChromeProfile {
  avatarDataUrl?: string;
  email?: string;
  id: BrowserNodeChromeProfileId;
  name: string;
}

export type BrowserNodeChromeProfileDiscoveryResult =
  | {
      profiles: readonly BrowserNodeChromeProfile[];
      status: "available";
    }
  | {
      reason:
        | "disabled"
        | "no-profiles"
        | "unsupported-platform"
        | "unavailable";
      status: "unavailable";
    };

export interface BrowserNodeChromeCookieImportInput extends BrowserNodeNodeIdInput {
  operationId: string;
  profileId: BrowserNodeChromeProfileId;
}

export interface BrowserNodeCancelChromeCookieImportInput {
  operationId: string;
}

export interface BrowserNodeDownloadDirectoryResult {
  canceled: boolean;
  directoryPath: string | null;
}

export type BrowserNodeDownloadAction =
  | "cancel"
  | "open"
  | "pause"
  | "resume"
  | "show-in-folder";

export interface BrowserNodeDownloadActionInput extends BrowserNodeNodeIdInput {
  action: BrowserNodeDownloadAction;
  downloadId: string;
}

export interface BrowserNodeScreenshotSaveResult {
  filePath: string | null;
  saved: boolean;
}

export interface BrowserNodeDebugDump {
  canGoBack: boolean;
  canGoForward: boolean;
  currentUrl: string | null;
  desiredUrl: string;
  isAttachedToWindow: boolean;
  isLoading: boolean;
  lifecycle: BrowserNodeLifecycle;
  nodeId: string;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition: string | null;
  title: string | null;
  userAgent: string | null;
  webContentsDestroyed: boolean | null;
  webContentsId: number | null;
}

export interface BrowserNodeHostApi {
  activate(payload: BrowserNodeActivationInput): Promise<void>;
  capturePreview?(payload: BrowserNodeNodeIdInput): Promise<string | null>;
  close(payload: BrowserNodeNodeIdInput): Promise<void>;
  clearBrowsingData?(payload: BrowserNodeNodeIdInput): Promise<void>;
  cancelChromeCookieImport?(
    payload: BrowserNodeCancelChromeCookieImportInput
  ): Promise<void>;
  chooseDownloadDirectory?(
    payload: BrowserNodeNodeIdInput
  ): Promise<BrowserNodeDownloadDirectoryResult>;
  debugDump?(
    payload: BrowserNodeNodeIdInput
  ): Promise<BrowserNodeDebugDump | null>;
  goBack(payload: BrowserNodeNodeIdInput): Promise<void>;
  goForward(payload: BrowserNodeNodeIdInput): Promise<void>;
  findInPage?(payload: BrowserNodeFindInPageInput): Promise<void>;
  importCookies?(
    payload: BrowserNodeNodeIdInput
  ): Promise<BrowserNodeCookieImportResult>;
  discoverChromeCookieProfiles?(): Promise<BrowserNodeChromeProfileDiscoveryResult>;
  importChromeCookies?(
    payload: BrowserNodeChromeCookieImportInput
  ): Promise<BrowserNodeCookieImportResult>;
  navigate(payload: BrowserNodeNavigateInput): Promise<void>;
  onEvent(listener: (event: BrowserNodeEvent) => void): () => void;
  openDevTools?(payload: BrowserNodeNodeIdInput): Promise<void>;
  openExternal?(payload: BrowserNodeOpenExternalInput): Promise<void>;
  performDownloadAction?(
    payload: BrowserNodeDownloadActionInput
  ): Promise<void>;
  prepareSession(payload: BrowserNodePrepareSessionInput): Promise<void>;
  printPage?(payload: BrowserNodeNodeIdInput): Promise<void>;
  registerGuest(payload: BrowserNodeRegisterGuestInput): Promise<void>;
  reload(payload: BrowserNodeNodeIdInput): Promise<void>;
  saveScreenshot?(
    payload: BrowserNodeSaveScreenshotInput
  ): Promise<BrowserNodeScreenshotSaveResult>;
  setDeviceEmulation?(
    payload: BrowserNodeSetDeviceEmulationInput
  ): Promise<void>;
  setZoomFactor?(payload: BrowserNodeSetZoomFactorInput): Promise<void>;
  showDevToolsContextMenu?(
    payload: BrowserNodeShowDevToolsContextMenuInput
  ): Promise<void>;
  stopFindInPage?(payload: BrowserNodeStopFindInPageInput): Promise<void>;
  unregisterGuest(payload: BrowserNodeUnregisterGuestInput): Promise<void>;
  updateAutomationTarget?(
    payload: BrowserNodeUpdateAutomationTargetInput
  ): Promise<void>;
}
