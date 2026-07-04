import type {
  AgentProviderProbeListInput,
  AgentProviderProbeListResult
} from "@tutti-os/agent-gui";
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
  DesktopReadDockPreviewInput,
  DesktopSetCustomWallpaperInput,
  DesktopWriteDockPreviewInput,
  ExportDeveloperLogsResult,
  ConfigureAppUpdatesInput,
  DesktopWorkspaceAppFolderKind,
  DesktopHostWindowCapturePreviewInput,
  DesktopHostWindowCloseRequestPayload,
  DesktopHostWindowCloseRequestResolutionPayload,
  DesktopRendererDiagnosticPayload,
  DesktopTerminalDiagnosticPayload,
  DesktopTerminalStreamUrlRequest,
  DesktopWorkspaceAppExternalRendererEvent,
  DesktopWorkspaceAppExternalRendererRequest,
  DesktopWorkspaceAppExternalRendererResult,
  DesktopWorkspaceAppOpenFileResolvedPayload,
  DesktopWorkspaceOpenFeatureRequest,
  DesktopArchiveAgentPromptFileInput,
  DesktopArchiveAgentPromptFileResult
} from "../shared/contracts/ipc";
import type { BrowserNodeHostApi } from "@tutti-os/browser-node";

export interface DesktopRuntimeApi {
  getBackendConfig(): Promise<DesktopBackendConfig>;
  getBusinessEventStreamUrl(): Promise<string>;
  listWorkspaceAgentProbes(
    input: AgentProviderProbeListInput
  ): Promise<AgentProviderProbeListResult>;
  logRendererDiagnostic(input: DesktopRendererDiagnosticPayload): Promise<void>;
  logTerminalDiagnostic(input: DesktopTerminalDiagnosticPayload): Promise<void>;
  getTerminalStreamUrl(input: DesktopTerminalStreamUrlRequest): Promise<string>;
}

export interface DesktopDeveloperApi {
  clearLogs(): Promise<ClearDeveloperLogsResult>;
  exportLogs(): Promise<ExportDeveloperLogsResult>;
  getLogsState(): Promise<DesktopDeveloperLogsState>;
  openLogDirectory(): Promise<void>;
  openLogFile(kind: DesktopDeveloperLogKind): Promise<void>;
}

export interface DesktopDockPreviewCacheApi {
  read(input: DesktopReadDockPreviewInput): Promise<string | null>;
  write(input: DesktopWriteDockPreviewInput): Promise<void>;
}

export interface DesktopPlatformApi {
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
  capturePreview(
    input: DesktopHostWindowCapturePreviewInput
  ): Promise<string | null>;
  onCloseRequest(
    listener: (payload: DesktopHostWindowCloseRequestPayload) => void
  ): () => void;
  onQuitShortcutToast(listener: () => void): () => void;
  resolveCloseRequest(
    payload: DesktopHostWindowCloseRequestResolutionPayload
  ): void;
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
  window: DesktopHostWindowApi;
  workspace: DesktopHostWorkspaceApi;
}

export type DesktopBrowserApi = Pick<
  BrowserNodeHostApi,
  | "activate"
  | "capturePreview"
  | "close"
  | "goBack"
  | "goForward"
  | "navigate"
  | "onEvent"
  | "openDevTools"
  | "openExternal"
  | "prepareSession"
  | "registerGuest"
  | "reload"
  | "showDevToolsContextMenu"
  | "unregisterGuest"
>;

export interface DesktopUpdateApi {
  checkForUpdates(): Promise<AppUpdateState>;
  configure(payload: ConfigureAppUpdatesInput): Promise<AppUpdateState>;
  downloadUpdate(): Promise<AppUpdateState>;
  getState(): Promise<AppUpdateState>;
  installUpdate(): Promise<void>;
  onState(listener: (state: AppUpdateState) => void): () => void;
}

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
  platform: DesktopPlatformApi;
  host: DesktopHostApi;
  runtime: DesktopRuntimeApi;
  update: DesktopUpdateApi;
  wallpaper: DesktopWallpaperApi;
  workspaceAppExternal?: DesktopWorkspaceAppExternalHostApi;
}
