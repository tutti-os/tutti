import type {
  AgentProviderProbeListInput,
  AgentProviderProbeListResult
} from "@tutti-os/agent-gui";
import type { DesktopPreferencesStateResponse } from "@tutti-os/client-tuttid-ts";
import type {
  DesktopFeatureAvailabilityApi,
  DesktopMinimumVersionApi
} from "@tutti-os/desktop-update-admission/contracts";
import type {
  DesktopBackendConfig,
  DesktopComputerUseActionResult,
  DesktopComputerUsePermissionGrantStatus,
  DesktopComputerUsePermissionPane,
  DesktopComputerUseRestartDriverInput,
  DesktopComputerUseRestartDriverResult,
  DesktopComputerUseStatus,
  DesktopClipboardImagePayload,
  DesktopCreateUserDocumentsProjectDirectoryResult,
  DesktopCustomWallpaperImage,
  DesktopLocalFileTextResult,
  DesktopHostNotificationNavigationPayload,
  DesktopHostNotificationPayload,
  DesktopHostNotificationResult,
  DesktopSelectUploadFilesInput,
  DesktopOpenWithApplication,
  AppUpdateState,
  ClearDeveloperLogsResult,
  DesktopDeveloperLogKind,
  DesktopDeveloperLogsState,
  ExportDeveloperLogsInput,
  DesktopReadDockPreviewInput,
  DesktopSetCustomWallpaperInput,
  DesktopWriteDockPreviewInput,
  ExportDeveloperLogsResult,
  ConfigureAppUpdatesInput,
  DesktopWorkspaceAppFolderKind,
  DesktopHostWindowCapturePreviewInput,
  DesktopHostWindowPreviewImages,
  DesktopHostOpenAgentWindowInput,
  DesktopHostWindowCloseRequestPayload,
  DesktopHostWindowCloseRequestResolutionPayload,
  DesktopHostWindowLayoutPayload,
  DesktopHostWindowResizeContentWidthInput,
  DesktopHostWindowResizeContentWidthResult,
  DesktopLaunchAgentSessionReplayInput,
  DesktopLaunchAgentSessionReplayResult,
  DesktopRevealAgentSessionReplayCassetteInput,
  DesktopAgentSessionReplayPlayback,
  DesktopGetAgentSessionReplayPlaybackInput,
  DesktopGetAgentSessionReplayStatusInput,
  DesktopImportAgentSessionReplayCassettesInput,
  DesktopImportAgentSessionReplayCassettesResult,
  DesktopAgentSessionReplayStatus,
  DesktopSendAgentSessionReplayControlInput,
  DesktopSetAgentSessionReplayPlaybackInput,
  DesktopWaitAgentSessionReplayInput,
  DesktopWaitAgentSessionReplayResult,
  DesktopRendererDiagnosticPayload,
  DesktopTerminalDiagnosticPayload,
  DesktopTerminalStreamUrlRequest,
  DesktopWorkspaceAppExternalRendererEvent,
  DesktopWorkspaceAppExternalRendererRequest,
  DesktopWorkspaceAppExternalRendererResult,
  DesktopWorkspaceAppOpenFileResolvedPayload,
  DesktopWorkspaceOpenFeatureRequest,
  DesktopArchiveAgentPromptFileInput,
  DesktopArchiveAgentPromptFileResult,
  DesktopBrowserAutomationRequest,
  DesktopBrowserAutomationHostReady,
  DesktopBrowserAutomationTurnClaim,
  DesktopBrowserAutomationResponse,
  DesktopWorkspaceAppPopupRejectedEvent
} from "../shared/contracts/ipc";
import type { BrowserNodeHostApi } from "@tutti-os/browser-node";
import type { DesktopDistribution } from "../shared/distribution/desktopDistribution.ts";

export interface DesktopRuntimeApi {
  getAgentSessionReplayPlayback(
    input: DesktopGetAgentSessionReplayPlaybackInput
  ): Promise<DesktopAgentSessionReplayPlayback>;
  getAgentSessionReplayStatus(
    input: DesktopGetAgentSessionReplayStatusInput
  ): Promise<DesktopAgentSessionReplayStatus>;
  getBackendConfig(): Promise<DesktopBackendConfig>;
  getBusinessEventStreamUrl(): Promise<string>;
  importAgentSessionReplayCassettes(
    input: DesktopImportAgentSessionReplayCassettesInput
  ): Promise<DesktopImportAgentSessionReplayCassettesResult>;
  /**
   * True only inside the isolated Agent Session Replay Desktop runtime
   * (launched with TUTTI_AGENT_CASSETTE_MODE=replay). Synchronous so window
   * composition can gate replay-only machinery at mount time. Optional so
   * lightweight runtime fakes and the dev-web fallback stay valid.
   */
  isAgentSessionReplayRuntime?(): boolean;
  launchAgentSessionReplay(
    input: DesktopLaunchAgentSessionReplayInput
  ): Promise<DesktopLaunchAgentSessionReplayResult>;
  revealAgentSessionReplayCassette(
    input: DesktopRevealAgentSessionReplayCassetteInput
  ): Promise<void>;
  setAgentSessionReplayPlayback(
    input: DesktopSetAgentSessionReplayPlaybackInput
  ): Promise<DesktopAgentSessionReplayPlayback>;
  sendAgentSessionReplayControl(
    input: DesktopSendAgentSessionReplayControlInput
  ): Promise<void>;
  waitForAgentSessionReplay(
    input: DesktopWaitAgentSessionReplayInput
  ): Promise<DesktopWaitAgentSessionReplayResult>;
  listWorkspaceAgentProbes(
    input: AgentProviderProbeListInput
  ): Promise<AgentProviderProbeListResult>;
  logRendererDiagnostic(input: DesktopRendererDiagnosticPayload): Promise<void>;
  logTerminalDiagnostic(input: DesktopTerminalDiagnosticPayload): Promise<void>;
  getTerminalStreamUrl(input: DesktopTerminalStreamUrlRequest): Promise<string>;
}

export interface DesktopDeveloperApi {
  clearLogs(): Promise<ClearDeveloperLogsResult>;
  exportLogs(
    input: ExportDeveloperLogsInput
  ): Promise<ExportDeveloperLogsResult>;
  getLogsState(): Promise<DesktopDeveloperLogsState>;
  openLogDirectory(): Promise<void>;
  openLogFile(kind: DesktopDeveloperLogKind): Promise<void>;
}

export interface DesktopDockPreviewCacheApi {
  read(input: DesktopReadDockPreviewInput): Promise<string | null>;
  write(input: DesktopWriteDockPreviewInput): Promise<void>;
}

export interface DesktopPlatformApi {
  distribution: DesktopDistribution;
  /** The native Electron application name, including the development suffix. */
  appName: string;
  homeDirectory: string;
  os: NodeJS.Platform;
  resolveDroppedEntries(files: File[]): DesktopDroppedEntry[];
  resolveDroppedPaths(files: File[]): string[];
}

export interface DesktopDroppedEntry {
  kind: "file" | "folder";
  path: string;
}

export interface DesktopHostWorkspaceApi {
  broadcastAgentStatus(payload: { agentBound: boolean }): void;
  onOpenFeatureRequest(
    listener: (request: DesktopWorkspaceOpenFeatureRequest) => void
  ): () => void;
  onOpenFileRequest(
    listener: (request: DesktopWorkspaceAppOpenFileResolvedPayload) => void
  ): () => void;
  openWorkspaceAppFolder(input: {
    appId: string;
    folderKind: DesktopWorkspaceAppFolderKind;
    workspaceId: string;
    version?: string | null;
  }): Promise<void>;
  replaceWorkspaceWindow(input: {
    clientTs: number;
    mode: "agent" | "os";
    previousMode: "agent" | "os";
    workspaceId: string;
  }): Promise<void>;
  showWorkspace(workspaceID: string): Promise<void>;
}

export interface DesktopHostNotificationsApi {
  show(
    input: DesktopHostNotificationPayload
  ): Promise<DesktopHostNotificationResult>;
  onNavigate(
    listener: (payload: DesktopHostNotificationNavigationPayload) => void
  ): () => void;
}

export interface DesktopHostWindowApi {
  approveClose(): Promise<void>;
  setCloseGuardEnabled(enabled: boolean): Promise<void>;
  capturePreview(
    input: DesktopHostWindowCapturePreviewInput
  ): Promise<string | null>;
  capturePreviewImages(
    input: DesktopHostWindowCapturePreviewInput
  ): Promise<DesktopHostWindowPreviewImages | null>;
  minimize(): Promise<void>;
  openAgentWindow(input: DesktopHostOpenAgentWindowInput): Promise<void>;
  onCloseRequest(
    listener: (payload: DesktopHostWindowCloseRequestPayload) => void
  ): () => void;
  onLayout(
    listener: (payload: DesktopHostWindowLayoutPayload) => void
  ): () => void;
  onQuitShortcutToast(listener: () => void): () => void;
  resolveCloseRequest(
    payload: DesktopHostWindowCloseRequestResolutionPayload
  ): void;
  resizeContentWidth(
    input: DesktopHostWindowResizeContentWidthInput
  ): Promise<DesktopHostWindowResizeContentWidthResult>;
  toggleMaximize(): Promise<void>;
}

export type DesktopWorkspaceAppExternalHostRequestResult =
  DesktopWorkspaceAppExternalRendererResult;

export interface DesktopWorkspaceAppExternalHostApi {
  onRequest(
    listener: (
      request: DesktopWorkspaceAppExternalRendererRequest
    ) =>
      | Promise<DesktopWorkspaceAppExternalHostRequestResult>
      | DesktopWorkspaceAppExternalHostRequestResult
  ): () => void;
  sendEvent(event: DesktopWorkspaceAppExternalRendererEvent): void;
}

export interface DesktopWorkspaceAppApi {
  onPopupRejected(
    listener: (event: DesktopWorkspaceAppPopupRejectedEvent) => void
  ): () => void;
}

export interface DesktopHostFilesApi {
  createUserDocumentsProjectDirectory(input: {
    name: string;
    allowExisting?: boolean;
  }): Promise<DesktopCreateUserDocumentsProjectDirectoryResult>;
  selectAppArchive(): Promise<string | null>;
  selectAppArchiveExportPath(input: {
    defaultPath: string;
  }): Promise<string | null>;
  selectAppIconImage(): Promise<string | null>;
  selectDirectory(): Promise<string | null>;
  openFile(workspaceID: string, path: string): Promise<void>;
  listOpenWithApplications(
    workspaceID: string,
    path: string
  ): Promise<DesktopOpenWithApplication[]>;
  openFileWithApplication(
    workspaceID: string,
    path: string,
    applicationPath: string
  ): Promise<void>;
  openFileWithOtherApplication(
    workspaceID: string,
    path: string,
    applicationPickerPrompt?: string
  ): Promise<void>;
  openFileInBrowser(workspaceID: string, path: string): Promise<void>;
  resolveWorkspaceFileFileUrl(
    workspaceID: string,
    path: string
  ): Promise<string>;
  revealInFolder(path: string): Promise<void>;
  revealWorkspaceFile(workspaceID: string, path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openTerminalLink(input: {
    column?: number;
    cwd?: string | null;
    line?: number;
    path: string;
    workspaceID: string;
  }): Promise<void>;
  readLocalFileText(path: string): Promise<DesktopLocalFileTextResult>;
  readLocalPreviewFile(path: string): Promise<Uint8Array>;
  archiveAgentPromptFile(
    input: DesktopArchiveAgentPromptFileInput
  ): Promise<DesktopArchiveAgentPromptFileResult>;
  readPreviewFile(workspaceID: string, path: string): Promise<Uint8Array>;
  resolveEntryIcon(
    workspaceID: string,
    entry: {
      kind: string;
      mtimeMs: number | null;
      name: string;
      path: string;
    }
  ): Promise<string | null>;
  selectUploadFiles(input?: DesktopSelectUploadFilesInput): Promise<string[]>;
  copyImageToClipboard(input: DesktopClipboardImagePayload): Promise<void>;
  copyFilesToClipboard(paths: string[]): Promise<void>;
}

export interface DesktopHostApi {
  files: DesktopHostFilesApi;
  notifications: DesktopHostNotificationsApi;
  preferences?: DesktopHostPreferencesApi;
  window: DesktopHostWindowApi;
  workspace: DesktopHostWorkspaceApi;
}

export interface DesktopHostPreferencesApi {
  ensureInitialized(): Promise<DesktopPreferencesStateResponse>;
}

export type DesktopBrowserApi = Pick<
  BrowserNodeHostApi,
  | "activate"
  | "capturePreview"
  | "chooseDownloadDirectory"
  | "clearBrowsingData"
  | "cancelChromeCookieImport"
  | "close"
  | "findInPage"
  | "discoverChromeCookieProfiles"
  | "importCookies"
  | "importChromeCookies"
  | "goBack"
  | "goForward"
  | "navigate"
  | "onEvent"
  | "openDevTools"
  | "openExternal"
  | "performDownloadAction"
  | "prepareSession"
  | "printPage"
  | "registerGuest"
  | "reload"
  | "saveScreenshot"
  | "setDeviceEmulation"
  | "setZoomFactor"
  | "showDevToolsContextMenu"
  | "stopFindInPage"
  | "unregisterGuest"
  | "updateAutomationTarget"
> & {
  announceAutomationHostReady?(input: DesktopBrowserAutomationHostReady): void;
  claimAutomationTurn?(input: DesktopBrowserAutomationTurnClaim): void;
  onAutomationRequest(
    listener: (request: DesktopBrowserAutomationRequest) => void
  ): () => void;
  respondAutomationRequest(response: DesktopBrowserAutomationResponse): void;
};

export interface DesktopUpdateApi {
  checkForUpdates(): Promise<AppUpdateState>;
  configure(payload: ConfigureAppUpdatesInput): Promise<AppUpdateState>;
  downloadUpdate(): Promise<AppUpdateState>;
  getState(): Promise<AppUpdateState>;
  installUpdate(): Promise<void>;
  onState(listener: (state: AppUpdateState) => void): () => void;
}

export type { DesktopMinimumVersionApi };

export interface DesktopWallpaperApi {
  clearCustom(): Promise<void>;
  getCustom(): Promise<DesktopCustomWallpaperImage | null>;
  setCustom(
    input: DesktopSetCustomWallpaperInput
  ): Promise<DesktopCustomWallpaperImage>;
}

export interface DesktopComputerUseApi {
  checkStatus(): Promise<DesktopComputerUseStatus>;
  install(): Promise<DesktopComputerUseActionResult>;
  uninstall(): Promise<DesktopComputerUseActionResult>;
  grantPermissions(): Promise<DesktopComputerUseActionResult>;
  startPermissionGrant(): Promise<DesktopComputerUsePermissionGrantStatus>;
  getPermissionGrantStatus(): Promise<DesktopComputerUsePermissionGrantStatus | null>;
  openPermissionSettings(pane: DesktopComputerUsePermissionPane): Promise<void>;
  restartDriver(
    input?: DesktopComputerUseRestartDriverInput
  ): Promise<DesktopComputerUseRestartDriverResult>;
}

export interface DesktopApi {
  browser?: DesktopBrowserApi;
  computerUse: DesktopComputerUseApi;
  developer: DesktopDeveloperApi;
  dockPreviewCache: DesktopDockPreviewCacheApi;
  featureAvailability?: DesktopFeatureAvailabilityApi;
  platform: DesktopPlatformApi;
  host: DesktopHostApi;
  runtime: DesktopRuntimeApi;
  update: DesktopUpdateApi;
  wallpaper: DesktopWallpaperApi;
  workspaceApp?: DesktopWorkspaceAppApi;
  workspaceAppExternal?: DesktopWorkspaceAppExternalHostApi;
}
