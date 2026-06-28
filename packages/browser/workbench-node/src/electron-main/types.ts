import type {
  BrowserNodeActivationInput,
  BrowserNodeDebugDump,
  BrowserNodeEvent,
  BrowserNodeGuestOpenUrlInput,
  BrowserNodeNavigateInput,
  BrowserNodeNodeIdInput,
  BrowserNodeOpenExternalInput,
  BrowserNodePrepareSessionInput,
  BrowserNodeRegisterGuestInput,
  BrowserNodeShowDevToolsContextMenuInput,
  BrowserNodeUnregisterGuestInput
} from "../core/types.ts";

export interface BrowserGuestManager {
  activate(input: BrowserNodeActivationInput): Promise<void>;
  capturePreview(input: BrowserNodeNodeIdInput): Promise<string | null>;
  close(input: BrowserNodeNodeIdInput): Promise<void>;
  debugDump(input: BrowserNodeNodeIdInput): BrowserNodeDebugDump | null;
  dispose(): void;
  goBack(input: BrowserNodeNodeIdInput): Promise<void>;
  goForward(input: BrowserNodeNodeIdInput): Promise<void>;
  handleGuestOpenUrl(
    webContentsId: number,
    input: BrowserNodeGuestOpenUrlInput
  ): void;
  navigate(input: BrowserNodeNavigateInput): Promise<void>;
  openDevTools(input: BrowserNodeNodeIdInput): Promise<void>;
  openExternal(input: BrowserNodeOpenExternalInput): Promise<void>;
  prepareSession(input: BrowserNodePrepareSessionInput): Promise<void>;
  registerGuest(input: BrowserNodeRegisterGuestInput): Promise<void>;
  reload(input: BrowserNodeNodeIdInput): Promise<void>;
  unregisterGuest(input: BrowserNodeUnregisterGuestInput): Promise<void>;
}

export type BrowserNodeShowDevToolsContextMenuPayload =
  BrowserNodeShowDevToolsContextMenuInput;

export type BrowserPreferredColorScheme = "dark" | "light";

export interface BrowserGuestManagerInput {
  emit: (event: BrowserNodeEvent) => void;
  getPreferredColorScheme?: () => BrowserPreferredColorScheme;
  logger?: BrowserNodeElectronLogger;
  openExternal: (url: string) => Promise<void> | void;
  prepareSession?: (
    input: BrowserNodePrepareSessionInput
  ) => Promise<void> | void;
  resolveWebContents: (webContentsId: number) => BrowserGuestWebContents | null;
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
  readonly navigationHistory?: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
  };
  canGoBack(): boolean;
  canGoForward(): boolean;
  capturePage?(): Promise<BrowserGuestNativeImage>;
  getTitle(): string;
  getURL(): string;
  getUserAgent?(): string;
  insertCSS?(css: string): Promise<string>;
  goBack(): void;
  goForward(): void;
  isDestroyed(): boolean;
  isLoading(): boolean;
  loadURL(url: string): Promise<void>;
  off(event: string, listener: (...args: unknown[]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  openDevTools?(options?: BrowserGuestOpenDevToolsOptions): void;
  reload(): void;
  setUserAgent?(userAgent: string): void;
  setWindowOpenHandler?(
    handler: (details: { url: string }) => BrowserGuestWindowOpenHandlerResponse
  ): void;
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
