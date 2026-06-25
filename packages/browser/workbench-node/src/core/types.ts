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
  error: BrowserNodeRuntimeError | null;
  isAttachedToWindow: boolean;
  isLoading: boolean;
  isOccluded: boolean;
  lifecycle: BrowserNodeLifecycle;
  title: string | null;
  url: string | null;
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
  | BrowserNodeOpenUrlEvent;

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
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition?: string | null;
  url?: string;
  webContentsId: number;
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
  debugDump?(
    payload: BrowserNodeNodeIdInput
  ): Promise<BrowserNodeDebugDump | null>;
  goBack(payload: BrowserNodeNodeIdInput): Promise<void>;
  goForward(payload: BrowserNodeNodeIdInput): Promise<void>;
  navigate(payload: BrowserNodeNavigateInput): Promise<void>;
  onEvent(listener: (event: BrowserNodeEvent) => void): () => void;
  openDevTools?(payload: BrowserNodeNodeIdInput): Promise<void>;
  openExternal?(payload: BrowserNodeOpenExternalInput): Promise<void>;
  prepareSession(payload: BrowserNodePrepareSessionInput): Promise<void>;
  registerGuest(payload: BrowserNodeRegisterGuestInput): Promise<void>;
  reload(payload: BrowserNodeNodeIdInput): Promise<void>;
  showDevToolsContextMenu?(
    payload: BrowserNodeShowDevToolsContextMenuInput
  ): Promise<void>;
  unregisterGuest(payload: BrowserNodeUnregisterGuestInput): Promise<void>;
}
