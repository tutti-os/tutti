import { isDesktopLocale, type DesktopLocale } from "../i18n/core/locale.ts";
import {
  isDesktopThemeSource,
  type DesktopThemeSource,
  type DesktopThemeState
} from "../theme/index.ts";
import type {
  DesktopAgentComposerDefaultsByProvider,
  DesktopAgentProvider,
  DesktopSleepPreventionMode
} from "../preferences/index.ts";
import type {
  AgentProviderProbeListInput,
  AgentProviderProbeListResult
} from "@tutti-os/agent-gui";
import type {
  BrowserNodeActivationInput,
  BrowserNodeEvent,
  BrowserNodeNavigateInput,
  BrowserNodeNodeIdInput,
  BrowserNodeOpenExternalInput,
  BrowserNodePrepareSessionInput,
  BrowserNodeRegisterGuestInput,
  BrowserNodeShowDevToolsContextMenuInput,
  BrowserNodeUnregisterGuestInput
} from "@tutti-os/browser-node";

export const desktopIpcChannels = {
  appContext: {
    changed: "workspace-app-context:changed",
    diagnostic: "workspace-app-context:diagnostic",
    get: "workspace-app-context:get",
    openSettings: "workspace-app-settings:open",
    openSettingsRequested: "workspace-app-settings:open-requested",
    openUrl: "workspace-app:open-url",
    requestManagedCredentialGrant:
      "workspace-app-managed-credentials:request-grant"
  },
  browser: {
    activate: "browser:activate",
    capturePreview: "browser:capturePreview",
    close: "browser:close",
    event: "browser:event",
    goBack: "browser:goBack",
    goForward: "browser:goForward",
    guestDiagnostic: "browser:guestDiagnostic",
    guestOpenUrl: "browser:guestOpenUrl",
    navigate: "browser:navigate",
    openDevTools: "browser:openDevTools",
    openExternal: "browser:openExternal",
    prepareSession: "browser:prepareSession",
    registerGuest: "browser:registerGuest",
    reload: "browser:reload",
    showDevToolsContextMenu: "browser:showDevToolsContextMenu",
    unregisterGuest: "browser:unregisterGuest"
  },
  dockPreviewCache: {
    read: "dock-preview-cache:read",
    write: "dock-preview-cache:write"
  },
  developer: {
    clearLogs: "developer:clearLogs",
    exportLogs: "developer:exportLogs",
    getLogsState: "developer:getLogsState",
    openLogDirectory: "developer:openLogDirectory",
    openLogFile: "developer:openLogFile"
  },
  runtime: {
    getBackendConfig: "runtime:getBackendConfig",
    getBusinessEventStreamUrl: "runtime:getBusinessEventStreamUrl",
    listWorkspaceAgentProbes: "runtime:listWorkspaceAgentProbes",
    logRendererDiagnostic: "runtime:logRendererDiagnostic",
    getTerminalStreamUrl: "runtime:getTerminalStreamUrl",
    logTerminalDiagnostic: "runtime:logTerminalDiagnostic"
  },
  update: {
    check: "update:check",
    configure: "update:configure",
    download: "update:download",
    getState: "update:getState",
    install: "update:install",
    state: "update:state"
  },
  wallpaper: {
    clearCustom: "wallpaper:clearCustom",
    getCustom: "wallpaper:getCustom",
    setCustom: "wallpaper:setCustom"
  },
  host: {
    files: {
      createUserDocumentsProjectDirectory:
        "host:files:createUserDocumentsProjectDirectory",
      openExternal: "host:files:openExternal",
      openFile: "host:files:openFile",
      listOpenWithApplications: "host:files:listOpenWithApplications",
      openFileWithApplication: "host:files:openFileWithApplication",
      openFileWithOtherApplication: "host:files:openFileWithOtherApplication",
      openFileInBrowser: "host:files:openFileInBrowser",
      resolveWorkspaceFileFileUrl: "host:files:resolveWorkspaceFileFileUrl",
      revealInFolder: "host:files:revealInFolder",
      revealWorkspaceFile: "host:files:revealWorkspaceFile",
      openTerminalLink: "host:files:openTerminalLink",
      readLocalFileText: "host:files:readLocalFileText",
      readPreviewFile: "host:files:readPreviewFile",
      resolveEntryIcon: "host:files:resolveEntryIcon",
      selectAppArchive: "host:files:selectAppArchive",
      selectAppArchiveExportPath: "host:files:selectAppArchiveExportPath",
      selectAppIconImage: "host:files:selectAppIconImage",
      selectDirectory: "host:files:selectDirectory",
      selectUploadFiles: "host:files:selectUploadFiles",
      copyFilesToClipboard: "host:files:copyFilesToClipboard"
    },
    window: {
      approveClose: "host:window:approveClose",
      capturePreview: "host:window:capturePreview",
      closeRequest: "host:window:closeRequest",
      layout: "host:window:layout"
    },
    workspace: {
      openWorkspaceAppFolder: "host:workspace:openWorkspaceAppFolder",
      showWorkspace: "host:workspace:showWorkspace"
    },
    notifications: {
      navigate: "host:notifications:navigate",
      show: "host:notifications:show"
    }
  }
} as const;

export interface DesktopHostWindowLayoutPayload {
  compactTitlebar: boolean;
}

export interface DesktopHostWindowCapturePreviewInput {
  maxHeight?: number;
  maxWidth?: number;
  rect: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
}

export interface DesktopWorkspaceFilePathPayload {
  path: string;
  workspaceID: string;
}

export interface DesktopOpenWithApplication {
  applicationPath: string;
  bundleIdentifier: string | null;
  iconDataUrl: string | null;
  name: string;
}

export interface DesktopWorkspaceFileOpenWithPayload extends DesktopWorkspaceFilePathPayload {
  applicationPath: string;
}

export interface DesktopWorkspaceFileOpenWithOtherPayload extends DesktopWorkspaceFilePathPayload {
  applicationPickerPrompt?: string;
}

export interface DesktopWorkspaceFileEntryIconPayload extends DesktopWorkspaceFilePathPayload {
  entryKind: string;
  entryMtimeMs: number | null;
  entryName: string;
}

export interface DesktopTerminalLinkPathPayload {
  column?: number;
  cwd?: string | null;
  line?: number;
  path: string;
  workspaceID: string;
}

export interface DesktopWorkspaceAppPayload {
  appId: string;
  folderKind: DesktopWorkspaceAppFolderKind;
  workspaceId: string;
  version?: string | null;
}

export type DesktopWorkspaceAppFolderKind =
  | "data"
  | "logs"
  | "package"
  | "runtime"
  | "workspace";

export interface DesktopLocalFileTextResult {
  content: string;
  name: string;
  path: string;
}

export interface DesktopCreateUserDocumentsProjectDirectoryInput {
  name: string;
}

export interface DesktopCreateUserDocumentsProjectDirectoryResult {
  path: string;
}

export type DesktopHostNotificationLevel =
  | "error"
  | "info"
  | "success"
  | "warning";

export interface DesktopHostNotificationNavigationPayload {
  agentSessionId: string;
  provider: string;
  workspaceId: string;
}

export interface DesktopHostNotificationPayload {
  body?: string;
  level: DesktopHostNotificationLevel;
  /**
   * When present, clicking the OS notification focuses the originating
   * window and emits this payload on the host notifications navigate
   * channel. Optional for backward compatibility.
   */
  navigation?: DesktopHostNotificationNavigationPayload;
  title: string;
}

export interface DesktopHostNotificationResult {
  reason?: "unsupported";
  shown: boolean;
}

export interface DesktopSelectAppArchiveExportPathInput {
  defaultPath: string;
}

export interface DesktopHostPreferencesSyncPayload {
  agentComposerDefaultsByProvider?: DesktopAgentComposerDefaultsByProvider;
  defaultAgentProvider?: DesktopAgentProvider;
  locale?: DesktopLocale;
  sleepPreventionMode?: DesktopSleepPreventionMode;
  themeSource?: DesktopThemeSource;
}

export interface DesktopWorkspaceAppContext {
  appId?: string;
  capabilities?: string[];
  contextToken?: string;
  installationId?: string;
  issuer?: string;
  locale: DesktopLocale;
  workspaceId?: string;
}

export type DesktopManagedModelProviderID = "agnes" | "openai" | "anthropic";

export interface DesktopManagedModel {
  id: string;
  name: string;
  provider: DesktopManagedModelProviderID;
}

export interface DesktopManagedModelGrantRequest {
  appId?: string;
  contextToken?: string;
  installationId?: string;
  nonce?: string;
  providers?: DesktopManagedModelProviderID[];
  scopes?: string[];
  state?: string;
  workspaceId?: string;
}

export interface DesktopManagedModelGrantResult {
  grantCode: string;
  expiresAt: string;
  providers: DesktopManagedModelProviderID[];
  models: DesktopManagedModel[];
}

export interface DesktopWorkspaceOpenSettingsRequest {
  pane: "managed-models";
  provider?: DesktopManagedModelProviderID;
  section: "apps";
}

export interface DesktopBackendConfig {
  accessToken: string;
  baseUrl: string;
}

export interface DesktopCustomWallpaperImage {
  bytes: Uint8Array;
  height: number;
  mimeType: string;
  thumbnailBytes: Uint8Array;
  thumbnailMimeType: string;
  updatedAt: string;
  width: number;
}

export interface DesktopSetCustomWallpaperInput {
  bytes: Uint8Array;
  height: number;
  mimeType: string;
  thumbnailBytes: Uint8Array;
  thumbnailMimeType: string;
  width: number;
}

export interface DesktopDockPreviewCacheKey {
  instanceId: string;
  instanceKey?: string | null;
  nodeId: string;
  typeId: string;
  workspaceId: string;
}

export interface DesktopReadDockPreviewInput {
  key: DesktopDockPreviewCacheKey;
}

export interface DesktopWriteDockPreviewInput {
  dataUrl: string;
  key: DesktopDockPreviewCacheKey;
}

export interface DesktopTerminalStreamUrlRequest {
  afterSeq?: number;
  sessionId: string;
  workspaceId: string;
}

export const desktopRuntimeLogLevels = [
  "debug",
  "info",
  "warn",
  "error"
] as const;

export type DesktopRuntimeLogLevel = (typeof desktopRuntimeLogLevels)[number];

export type DesktopTerminalDiagnosticDetails = Record<
  string,
  string | number | boolean | null
>;

export interface DesktopTerminalDiagnosticPayload {
  details?: DesktopTerminalDiagnosticDetails;
  event: string;
  level?: DesktopRuntimeLogLevel;
  nodeId?: string | null;
  sessionId?: string | null;
  workspaceId?: string | null;
}

export interface DesktopRendererDiagnosticPayload {
  details?: Record<string, unknown>;
  event: string;
  level?: DesktopRuntimeLogLevel;
  source: string;
  workspaceId?: string | null;
}

export interface DesktopApiErrorDetails {
  code: string;
  message: string;
  reason?: string;
  params?: Record<string, unknown>;
  retryable?: boolean;
  developerMessage?: string;
  correlationId?: string;
}

export interface DesktopIpcSuccess<TResult> {
  ok: true;
  data: TResult;
}

export interface DesktopIpcFailure {
  ok: false;
  error: DesktopApiErrorDetails;
}

export type DesktopIpcResult<TResult> =
  | DesktopIpcSuccess<TResult>
  | DesktopIpcFailure;

export const desktopDeveloperLogKinds = ["daemon", "desktop"] as const;

export type DesktopDeveloperLogKind = (typeof desktopDeveloperLogKinds)[number];

export interface DesktopDeveloperLogFileSummary {
  exists: boolean;
  kind: DesktopDeveloperLogKind;
  path: string;
  sizeBytes: number;
}

export interface DesktopDeveloperLogsState {
  desktopVersion: string;
  files: DesktopDeveloperLogFileSummary[];
  logsDir: string;
  totalFiles: number;
  totalSizeBytes: number;
}

export interface ClearDeveloperLogsResult {
  clearedFiles: number;
  clearedPaths: string[];
  clearedSizeBytes: number;
}

export interface ExportDeveloperLogsResult {
  canceled: boolean;
  fileCount: number;
  filePath: string | null;
}

export const appUpdatePolicies = ["off", "prompt", "auto"] as const;

export type AppUpdatePolicy = (typeof appUpdatePolicies)[number];

export const appUpdateChannels = ["stable", "rc"] as const;

export type AppUpdateChannel = (typeof appUpdateChannels)[number];

export const appUpdateStatuses = [
  "disabled",
  "unsupported",
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "up_to_date",
  "error"
] as const;

export type AppUpdateStatus = (typeof appUpdateStatuses)[number];

export interface ConfigureAppUpdatesInput {
  channel?: AppUpdateChannel;
  policy: AppUpdatePolicy;
}

export interface AppUpdateState {
  channel: AppUpdateChannel;
  checkedAt: string | null;
  currentVersion: string;
  downloadedBytes: number | null;
  downloadPercent: number | null;
  latestVersion: string | null;
  message: string | null;
  policy: AppUpdatePolicy;
  releaseDate: string | null;
  releaseName: string | null;
  releaseNotesUrl: string | null;
  status: AppUpdateStatus;
  totalBytes: number | null;
}

export { isDesktopLocale, type DesktopLocale };
export {
  isDesktopThemeSource,
  type DesktopThemeSource,
  type DesktopThemeState
};
export type { BrowserNodeEvent };

export interface DesktopInvokePayloadByChannel {
  [desktopIpcChannels.appContext.get]: undefined;
  [desktopIpcChannels.appContext
    .openSettings]: DesktopWorkspaceOpenSettingsRequest;
  [desktopIpcChannels.appContext
    .requestManagedCredentialGrant]: DesktopManagedModelGrantRequest;
  [desktopIpcChannels.browser.activate]: BrowserNodeActivationInput;
  [desktopIpcChannels.browser.capturePreview]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.close]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.goBack]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.goForward]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.navigate]: BrowserNodeNavigateInput;
  [desktopIpcChannels.browser.openDevTools]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.openExternal]: BrowserNodeOpenExternalInput;
  [desktopIpcChannels.browser.prepareSession]: BrowserNodePrepareSessionInput;
  [desktopIpcChannels.browser.registerGuest]: BrowserNodeRegisterGuestInput;
  [desktopIpcChannels.browser.reload]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser
    .showDevToolsContextMenu]: BrowserNodeShowDevToolsContextMenuInput;
  [desktopIpcChannels.browser.unregisterGuest]: BrowserNodeUnregisterGuestInput;
  [desktopIpcChannels.dockPreviewCache.read]: DesktopReadDockPreviewInput;
  [desktopIpcChannels.dockPreviewCache.write]: DesktopWriteDockPreviewInput;
  [desktopIpcChannels.developer.clearLogs]: undefined;
  [desktopIpcChannels.developer.exportLogs]: undefined;
  [desktopIpcChannels.developer.getLogsState]: undefined;
  [desktopIpcChannels.developer.openLogDirectory]: undefined;
  [desktopIpcChannels.developer.openLogFile]: DesktopDeveloperLogKind;
  [desktopIpcChannels.runtime.getBackendConfig]: undefined;
  [desktopIpcChannels.runtime.getBusinessEventStreamUrl]: undefined;
  [desktopIpcChannels.runtime
    .listWorkspaceAgentProbes]: AgentProviderProbeListInput;
  [desktopIpcChannels.runtime
    .getTerminalStreamUrl]: DesktopTerminalStreamUrlRequest;
  [desktopIpcChannels.runtime
    .logRendererDiagnostic]: DesktopRendererDiagnosticPayload;
  [desktopIpcChannels.runtime
    .logTerminalDiagnostic]: DesktopTerminalDiagnosticPayload;
  [desktopIpcChannels.update.check]: undefined;
  [desktopIpcChannels.update.configure]: ConfigureAppUpdatesInput;
  [desktopIpcChannels.update.download]: undefined;
  [desktopIpcChannels.update.getState]: undefined;
  [desktopIpcChannels.update.install]: undefined;
  [desktopIpcChannels.wallpaper.clearCustom]: undefined;
  [desktopIpcChannels.wallpaper.getCustom]: undefined;
  [desktopIpcChannels.wallpaper.setCustom]: DesktopSetCustomWallpaperInput;
  [desktopIpcChannels.host.files
    .createUserDocumentsProjectDirectory]: DesktopCreateUserDocumentsProjectDirectoryInput;
  [desktopIpcChannels.host.files.openExternal]: string;
  [desktopIpcChannels.host.files.openFile]: DesktopWorkspaceFilePathPayload;
  [desktopIpcChannels.host.files
    .listOpenWithApplications]: DesktopWorkspaceFilePathPayload;
  [desktopIpcChannels.host.files
    .openFileWithApplication]: DesktopWorkspaceFileOpenWithPayload;
  [desktopIpcChannels.host.files
    .openFileWithOtherApplication]: DesktopWorkspaceFileOpenWithOtherPayload;
  [desktopIpcChannels.host.files
    .openFileInBrowser]: DesktopWorkspaceFilePathPayload;
  [desktopIpcChannels.host.files
    .resolveWorkspaceFileFileUrl]: DesktopWorkspaceFilePathPayload;
  [desktopIpcChannels.host.files.revealInFolder]: string;
  [desktopIpcChannels.host.files
    .revealWorkspaceFile]: DesktopWorkspaceFilePathPayload;
  [desktopIpcChannels.host.files
    .openTerminalLink]: DesktopTerminalLinkPathPayload;
  [desktopIpcChannels.host.files.readLocalFileText]: string;
  [desktopIpcChannels.host.files
    .readPreviewFile]: DesktopWorkspaceFilePathPayload;
  [desktopIpcChannels.host.files
    .resolveEntryIcon]: DesktopWorkspaceFileEntryIconPayload;
  [desktopIpcChannels.host.files.selectAppArchive]: undefined;
  [desktopIpcChannels.host.files
    .selectAppArchiveExportPath]: DesktopSelectAppArchiveExportPathInput;
  [desktopIpcChannels.host.files.selectAppIconImage]: undefined;
  [desktopIpcChannels.host.files.selectDirectory]: undefined;
  [desktopIpcChannels.host.files.selectUploadFiles]: undefined;
  [desktopIpcChannels.host.files.copyFilesToClipboard]: string[];
  [desktopIpcChannels.host.window.approveClose]: undefined;
  [desktopIpcChannels.host.window
    .capturePreview]: DesktopHostWindowCapturePreviewInput;
  [desktopIpcChannels.host.workspace
    .openWorkspaceAppFolder]: DesktopWorkspaceAppPayload;
  [desktopIpcChannels.host.workspace.showWorkspace]: string;
  [desktopIpcChannels.host.notifications.show]: DesktopHostNotificationPayload;
}

export interface DesktopInvokeResultByChannel {
  [desktopIpcChannels.appContext.get]: DesktopWorkspaceAppContext;
  [desktopIpcChannels.appContext.openSettings]: void;
  [desktopIpcChannels.appContext
    .requestManagedCredentialGrant]: DesktopManagedModelGrantResult;
  [desktopIpcChannels.browser.activate]: void;
  [desktopIpcChannels.browser.capturePreview]: string | null;
  [desktopIpcChannels.browser.close]: void;
  [desktopIpcChannels.browser.goBack]: void;
  [desktopIpcChannels.browser.goForward]: void;
  [desktopIpcChannels.browser.navigate]: void;
  [desktopIpcChannels.browser.openDevTools]: void;
  [desktopIpcChannels.browser.openExternal]: void;
  [desktopIpcChannels.browser.prepareSession]: void;
  [desktopIpcChannels.browser.registerGuest]: void;
  [desktopIpcChannels.browser.reload]: void;
  [desktopIpcChannels.browser.showDevToolsContextMenu]: void;
  [desktopIpcChannels.browser.unregisterGuest]: void;
  [desktopIpcChannels.dockPreviewCache.read]: string | null;
  [desktopIpcChannels.dockPreviewCache.write]: void;
  [desktopIpcChannels.developer.clearLogs]: ClearDeveloperLogsResult;
  [desktopIpcChannels.developer.exportLogs]: ExportDeveloperLogsResult;
  [desktopIpcChannels.developer.getLogsState]: DesktopDeveloperLogsState;
  [desktopIpcChannels.developer.openLogDirectory]: void;
  [desktopIpcChannels.developer.openLogFile]: void;
  [desktopIpcChannels.runtime.getBackendConfig]: DesktopBackendConfig;
  [desktopIpcChannels.runtime.getBusinessEventStreamUrl]: string;
  [desktopIpcChannels.runtime
    .listWorkspaceAgentProbes]: AgentProviderProbeListResult;
  [desktopIpcChannels.runtime.getTerminalStreamUrl]: string;
  [desktopIpcChannels.runtime.logRendererDiagnostic]: void;
  [desktopIpcChannels.runtime.logTerminalDiagnostic]: void;
  [desktopIpcChannels.update.check]: AppUpdateState;
  [desktopIpcChannels.update.configure]: AppUpdateState;
  [desktopIpcChannels.update.download]: AppUpdateState;
  [desktopIpcChannels.update.getState]: AppUpdateState;
  [desktopIpcChannels.update.install]: void;
  [desktopIpcChannels.wallpaper.clearCustom]: void;
  [desktopIpcChannels.wallpaper.getCustom]: DesktopCustomWallpaperImage | null;
  [desktopIpcChannels.wallpaper.setCustom]: DesktopCustomWallpaperImage;
  [desktopIpcChannels.host.files
    .createUserDocumentsProjectDirectory]: DesktopCreateUserDocumentsProjectDirectoryResult;
  [desktopIpcChannels.host.files.openExternal]: void;
  [desktopIpcChannels.host.files.openFile]: void;
  [desktopIpcChannels.host.files
    .listOpenWithApplications]: DesktopOpenWithApplication[];
  [desktopIpcChannels.host.files.openFileWithApplication]: void;
  [desktopIpcChannels.host.files.openFileWithOtherApplication]: void;
  [desktopIpcChannels.host.files.openFileInBrowser]: void;
  [desktopIpcChannels.host.files.resolveWorkspaceFileFileUrl]: string;
  [desktopIpcChannels.host.files.revealInFolder]: void;
  [desktopIpcChannels.host.files.revealWorkspaceFile]: void;
  [desktopIpcChannels.host.files.openTerminalLink]: void;
  [desktopIpcChannels.host.files.readLocalFileText]: DesktopLocalFileTextResult;
  [desktopIpcChannels.host.files.readPreviewFile]: Uint8Array;
  [desktopIpcChannels.host.files.resolveEntryIcon]: string | null;
  [desktopIpcChannels.host.files.selectAppArchive]: string | null;
  [desktopIpcChannels.host.files.selectAppArchiveExportPath]: string | null;
  [desktopIpcChannels.host.files.selectAppIconImage]: string | null;
  [desktopIpcChannels.host.files.selectDirectory]: string | null;
  [desktopIpcChannels.host.files.selectUploadFiles]: string[];
  [desktopIpcChannels.host.files.copyFilesToClipboard]: void;
  [desktopIpcChannels.host.window.approveClose]: void;
  [desktopIpcChannels.host.window.capturePreview]: string | null;
  [desktopIpcChannels.host.workspace.openWorkspaceAppFolder]: void;
  [desktopIpcChannels.host.workspace.showWorkspace]: void;
  [desktopIpcChannels.host.notifications.show]: DesktopHostNotificationResult;
}

export type DesktopInvokeChannel = keyof DesktopInvokePayloadByChannel;
