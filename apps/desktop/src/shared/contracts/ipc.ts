import { isDesktopLocale, type DesktopLocale } from "../i18n/core/locale.ts";
import {
  isDesktopThemeSource,
  type DesktopThemeSource,
  type DesktopThemeState
} from "../theme/index.ts";
import type {
  DesktopAgentComposerDefaultsByProvider,
  DesktopAgentGuiConversationRailCollapsedByProvider,
  DesktopAgentProvider,
  DesktopFileDefaultOpenersByExtension,
  DesktopSleepPreventionMode
} from "../preferences/index.ts";
import type {
  AgentProviderProbeListInput,
  AgentProviderProbeListResult
} from "@tutti-os/agent-gui";
import type { DesktopAgentDirectorySnapshot } from "./agentDirectory.ts";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type {
  BrowserNodeActivationInput,
  BrowserNodeCookieImportResult,
  BrowserNodeDownloadDirectoryResult,
  BrowserNodeDownloadActionInput,
  BrowserNodeEvent,
  BrowserNodeFindInPageInput,
  BrowserNodeNavigateInput,
  BrowserNodeNodeIdInput,
  BrowserNodeOpenExternalInput,
  BrowserNodePrepareSessionInput,
  BrowserNodeRegisterGuestInput,
  BrowserNodeScreenshotSaveResult,
  BrowserNodeSaveScreenshotInput,
  BrowserNodeSetDeviceEmulationInput,
  BrowserNodeSetZoomFactorInput,
  BrowserNodeShowDevToolsContextMenuInput,
  BrowserNodeStopFindInPageInput,
  BrowserNodeUnregisterGuestInput
} from "@tutti-os/browser-node";
import type {
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult,
  TuttiExternalFileOpenInput,
  TuttiExternalFileSelectInput,
  TuttiExternalFileSelectResult,
  TuttiExternalUploadedFile,
  TuttiExternalLogInput,
  TuttiExternalPermissionRequestInput,
  TuttiExternalPermissionRequestResult,
  TuttiExternalPdfPrintHtmlInput,
  TuttiExternalPdfPrintHtmlResult,
  TuttiExternalReferenceOpenInput,
  TuttiExternalRendererRequest,
  TuttiExternalAtResolveResult,
  TuttiExternalAtResolveInput,
  TuttiExternalAtInvalidation,
  TuttiExternalAgentActivityActivateSessionResult,
  TuttiExternalAgentActivityActivateSessionInput,
  TuttiExternalAgentActivityCancelTurnResult,
  TuttiExternalAgentActivityCancelTurnInput,
  TuttiExternalAgentActivityComposerOptions,
  TuttiExternalAgentActivityComposerOptionsInput,
  TuttiExternalAgentActivitySendInput,
  TuttiExternalAgentActivitySendResult,
  TuttiExternalAgentActivitySnapshot,
  TuttiExternalAgentTargetCatalog,
  TuttiExternalSettingsOpenInput,
  TuttiExternalUserProjectCreateInput,
  TuttiExternalUserProjectPathInput,
  TuttiExternalUserProjectRememberDefaultSelectionInput,
  TuttiExternalWorkspaceOpenRouteIntent,
  TuttiExternalWorkspaceOpenFeatureInput
} from "@tutti-os/workspace-external-core/contracts";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectDefaultSelection,
  WorkspaceUserProjectMoveInput,
  WorkspaceUserProjectPathCheck,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput,
  WorkspaceUserProjectServiceSnapshot
} from "@tutti-os/workspace-user-project/contracts";

export const desktopIpcChannels = {
  computerUse: {
    checkStatus: "computerUse:checkStatus",
    install: "computerUse:install",
    uninstall: "computerUse:uninstall",
    grantPermissions: "computerUse:grantPermissions",
    startPermissionGrant: "computerUse:startPermissionGrant",
    getPermissionGrantStatus: "computerUse:getPermissionGrantStatus",
    openPermissionSettings: "computerUse:openPermissionSettings",
    restartDriver: "computerUse:restartDriver"
  },
  appContext: {
    agentStatusBroadcast: "workspace-app-context:agent-status-broadcast",
    changed: "workspace-app-context:changed",
    diagnostic: "workspace-app-context:diagnostic",
    get: "workspace-app-context:get",
    openFeatureRequested: "workspace-app-feature:open-requested",
    openFileRequested: "workspace-app-files:open-requested",
    openUrl: "workspace-app:open-url"
  },
  appExternal: {
    activityReportActive: "workspace-app-activity:report-active",
    agentActivityActivateSession:
      "workspace-app-agent-activity:activate-session",
    agentActivityCancelTurn: "workspace-app-agent-activity:cancel-turn",
    agentActivityGetComposerOptions:
      "workspace-app-agent-activity:get-composer-options",
    agentActivityGetSnapshot: "workspace-app-agent-activity:get-snapshot",
    agentActivityListTargets: "workspace-app-agent-activity:list-targets",
    agentActivitySendInput: "workspace-app-agent-activity:send-input",
    atQuery: "workspace-app-at:query",
    atResolve: "workspace-app-at:resolve",
    filesOpen: "workspace-app-files:open",
    filesSelect: "workspace-app-files:select",
    filesUploadCancel: "workspace-app-files:upload-cancel",
    filesUploadComplete: "workspace-app-files:upload-complete",
    filesUploadPrepare: "workspace-app-files:upload-prepare",
    logsWrite: "workspace-app-logs:write",
    permissionsRequest: "workspace-app-permissions:request",
    pdfPrintHtml: "workspace-app-pdf:print-html",
    referencesOpen: "workspace-app-references:open",
    guestEvent: "workspace-app-external:guest-event",
    rendererEvent: "workspace-app-external:renderer-event",
    rendererRequest: "workspace-app-external:renderer-request",
    rendererResponse: "workspace-app-external:renderer-response",
    settingsOpen: "workspace-app-settings:open",
    userProjectsCheckPath: "workspace-app-user-projects:check-path",
    userProjectsCreate: "workspace-app-user-projects:create",
    userProjectsGetDefaultSelection:
      "workspace-app-user-projects:get-default-selection",
    userProjectsGetSnapshot: "workspace-app-user-projects:get-snapshot",
    userProjectsList: "workspace-app-user-projects:list",
    userProjectsMove: "workspace-app-user-projects:move",
    userProjectsPrepareSelection:
      "workspace-app-user-projects:prepare-selection",
    userProjectsRefresh: "workspace-app-user-projects:refresh",
    userProjectsRememberDefaultSelection:
      "workspace-app-user-projects:remember-default-selection",
    userProjectsSelectDirectory: "workspace-app-user-projects:select-directory",
    userProjectsUse: "workspace-app-user-projects:use",
    workspaceFeatureOpen: "workspace-app-feature:open"
  },
  browser: {
    activate: "browser:activate",
    capturePreview: "browser:capturePreview",
    chooseDownloadDirectory: "browser:chooseDownloadDirectory",
    clearBrowsingData: "browser:clearBrowsingData",
    close: "browser:close",
    event: "browser:event",
    findInPage: "browser:findInPage",
    importCookies: "browser:importCookies",
    goBack: "browser:goBack",
    goForward: "browser:goForward",
    guestDiagnostic: "browser:guestDiagnostic",
    guestOpenUrl: "browser:guestOpenUrl",
    navigate: "browser:navigate",
    openDevTools: "browser:openDevTools",
    openExternal: "browser:openExternal",
    performDownloadAction: "browser:performDownloadAction",
    prepareSession: "browser:prepareSession",
    printPage: "browser:printPage",
    registerGuest: "browser:registerGuest",
    reload: "browser:reload",
    saveScreenshot: "browser:saveScreenshot",
    setDeviceEmulation: "browser:setDeviceEmulation",
    setZoomFactor: "browser:setZoomFactor",
    showDevToolsContextMenu: "browser:showDevToolsContextMenu",
    stopFindInPage: "browser:stopFindInPage",
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
      readLocalPreviewFile: "host:files:readLocalPreviewFile",
      archiveAgentPromptFile: "host:files:archiveAgentPromptFile",
      readPreviewFile: "host:files:readPreviewFile",
      resolveEntryIcon: "host:files:resolveEntryIcon",
      selectAppArchive: "host:files:selectAppArchive",
      selectAppArchiveExportPath: "host:files:selectAppArchiveExportPath",
      selectAppIconImage: "host:files:selectAppIconImage",
      selectDirectory: "host:files:selectDirectory",
      selectUploadFiles: "host:files:selectUploadFiles",
      copyImageToClipboard: "host:files:copyImageToClipboard",
      copyFilesToClipboard: "host:files:copyFilesToClipboard"
    },
    window: {
      approveClose: "host:window:approveClose",
      capturePreview: "host:window:capturePreview",
      closeRequest: "host:window:closeRequest",
      closeRequestResolved: "host:window:closeRequestResolved",
      layout: "host:window:layout",
      minimize: "host:window:minimize",
      minimizeState: "host:window:minimizeState",
      openAgentWindow: "host:window:openAgentWindow",
      quitShortcutToast: "host:window:quitShortcutToast",
      resizeContentWidth: "host:window:resizeContentWidth",
      toggleMaximize: "host:window:toggleMaximize"
    },
    workspace: {
      openWorkspaceAppFolder: "host:workspace:openWorkspaceAppFolder",
      replaceWorkspaceWindow: "host:workspace:replaceWorkspaceWindow",
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
  maximized: boolean;
}

export interface DesktopHostWindowMinimizeStatePayload {
  minimized: boolean;
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

export interface DesktopHostWindowResizeContentWidthInput {
  animate?: boolean;
  width: number;
}

export interface DesktopHostWindowResizeContentWidthResult {
  width: number;
}

export interface DesktopHostWindowCloseRequestPayload {
  requestId?: string;
  reason: "quit" | "window-close";
}

export interface DesktopHostOpenAgentWindowInput {
  agentDirectorySnapshot?: DesktopAgentDirectorySnapshot | null;
  agentSessionId?: string | null;
  agentTargetId?: string | null;
  autoSubmit?: boolean;
  draftPrompt?: string | null;
  providerStatusSnapshot?: DesktopAgentProviderStatusSnapshot | null;
  minimizeSourceWindow?: boolean;
  offsetFromSourceWindow?: boolean;
  provider?: string | null;
  userProjectPath?: string | null;
  workspaceId: string;
}

export interface DesktopHostReplaceWorkspaceWindowInput {
  mode: "agent" | "os";
  workspaceId: string;
}

export interface DesktopAgentProviderStatusSnapshot {
  capturedAt: string | null;
  defaultProvider: WorkspaceAgentProvider | null;
  error: string | null;
  isLoading: boolean;
  pendingActions: readonly {
    actionId: string;
    provider: WorkspaceAgentProvider;
  }[];
  statuses: readonly AgentProviderStatus[];
}

export interface DesktopHostWindowCloseRequestResolutionPayload {
  outcome: "approved" | "blocked";
  requestId: string;
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

export interface DesktopArchiveAgentPromptFileInput {
  dataBase64?: string;
  displayName?: string | null;
  hostPath?: string;
  mimeType?: string | null;
  workspaceID: string;
}

export interface DesktopArchiveAgentPromptFileResult {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface DesktopClipboardImagePayload {
  data: string;
  mimeType: "image/png";
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

export interface DesktopWorkspaceAppFileUploadPrepareInput {
  purpose: "app-asset";
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface DesktopWorkspaceAppFileUploadPrepareResult {
  expiresAt: string;
  headers: Record<string, string>;
  method: "PUT";
  uploadId: string;
  url: string;
}

export interface DesktopWorkspaceAppFileUploadCompleteInput {
  uploadId: string;
}

export interface DesktopWorkspaceAppFileUploadCancelInput {
  uploadId: string;
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
  /**
   * When true, an already-existing target directory is treated as success
   * instead of failing with `projectDirectoryAlreadyExists`. Used for
   * auto-generated `session-<uuid>` working directories, where a name
   * collision is harmless (the directory belongs to the same session).
   * User-named project creation must leave this unset to keep the
   * name-conflict error.
   */
  allowExisting?: boolean;
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

export interface DesktopSelectUploadFilesInput {
  allowDirectories?: boolean;
}

export interface DesktopHostPreferencesSyncPayload {
  agentComposerDefaultsByProvider?: DesktopAgentComposerDefaultsByProvider;
  agentGuiConversationRailCollapsedByProvider?: DesktopAgentGuiConversationRailCollapsedByProvider;
  fileDefaultOpenersByExtension?: DesktopFileDefaultOpenersByExtension;
  defaultAgentProvider?: DesktopAgentProvider;
  locale?: DesktopLocale;
  sleepPreventionMode?: DesktopSleepPreventionMode;
  themeSource?: DesktopThemeSource;
}

export interface DesktopWorkspaceAppContext {
  agentBound?: boolean;
  appId?: string;
  capabilities?: string[];
  contextToken?: string;
  installationId?: string;
  issuer?: string;
  launchIntent?: TuttiExternalWorkspaceOpenRouteIntent;
  locale: DesktopLocale;
  workspaceId?: string;
}

export type DesktopWorkspaceOpenFeatureRequest =
  TuttiExternalWorkspaceOpenFeatureInput;

export type DesktopWorkspaceAppFrontendLogPayload = TuttiExternalLogInput;

export type DesktopWorkspaceAppOpenFileMode = "auto" | "preview" | "reveal";

export type DesktopWorkspaceAppOpenFileLocationType =
  | "app-data-relative"
  | "app-package-relative"
  | "workspace-relative";

export interface DesktopWorkspaceAppOpenFileLocation {
  path: string;
  type: DesktopWorkspaceAppOpenFileLocationType;
}

export interface DesktopWorkspaceAppOpenFileRequest {
  location?: DesktopWorkspaceAppOpenFileLocation;
  mode?: DesktopWorkspaceAppOpenFileMode;
  mtimeMs?: number | null;
  name?: string;
  packageVersion?: string | null;
  path: string;
  sizeBytes?: number | null;
}

export interface DesktopWorkspaceAppOpenFileResolvedPayload {
  absolutePath: string;
  appId: string;
  mode: DesktopWorkspaceAppOpenFileMode;
  mtimeMs: number | null;
  name: string;
  sizeBytes: number | null;
  workspaceId: string;
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

export type DesktopWorkspaceAppExternalRendererResult =
  | TuttiExternalAgentActivityActivateSessionResult
  | TuttiExternalAgentActivityCancelTurnResult
  | TuttiExternalAgentActivityComposerOptions
  | TuttiExternalAgentActivitySendResult
  | TuttiExternalAgentActivitySnapshot
  | TuttiExternalAgentTargetCatalog
  | TuttiExternalAtQueryResult[]
  | TuttiExternalAtResolveResult
  | TuttiExternalFileSelectResult
  | WorkspaceUserProject
  | WorkspaceUserProjectDefaultSelection
  | WorkspaceUserProjectPathCheck
  | WorkspaceUserProjectSelectionPreparation
  | WorkspaceUserProjectServiceSnapshot
  | { path: string }
  | { projects: WorkspaceUserProject[] }
  | null
  | void;

export interface DesktopWorkspaceAppExternalRendererResponse {
  requestId: string;
  result: DesktopIpcResult<DesktopWorkspaceAppExternalRendererResult>;
}

export type DesktopWorkspaceAppExternalRendererEvent =
  | {
      invalidation: TuttiExternalAtInvalidation;
      type: "at.invalidated";
      workspaceId: string;
    }
  | {
      snapshot: WorkspaceUserProjectServiceSnapshot;
      type: "userProjects.changed";
      workspaceId: string;
    }
  | {
      appId: string;
      intent: TuttiExternalWorkspaceOpenRouteIntent;
      type: "workspace.launchIntent";
      workspaceId: string;
    };

export type DesktopWorkspaceAppExternalRendererRequest =
  TuttiExternalRendererRequest;

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

export type DesktopComputerUsePermissionStatusSource =
  | "driver-daemon"
  | "unknown";

export interface DesktopComputerUsePermissionsStatus {
  accessibility: boolean | null;
  screenRecording: boolean | null;
  screenRecordingCapturable: boolean | null;
  source: DesktopComputerUsePermissionStatusSource;
}

export type DesktopComputerUseAuthorizationState =
  | "authorized"
  | "needs-authorization"
  | "unknown";

export type DesktopComputerUseStatusReason =
  | "driver-daemon-not-running"
  | "not-installed"
  | "permission-missing"
  | "screen-recording-not-capturable"
  | "status-command-failed"
  | "status-unparseable";

export interface DesktopComputerUseStatus {
  installed: boolean;
  permissions: DesktopComputerUsePermissionsStatus | null;
  authorization: DesktopComputerUseAuthorizationState;
  reason?: DesktopComputerUseStatusReason;
  diagnosticMessage?: string;
}

export function desktopComputerUseStatusesEqual(
  left: DesktopComputerUseStatus | null,
  right: DesktopComputerUseStatus | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.installed === right.installed &&
      left.authorization === right.authorization &&
      left.reason === right.reason &&
      left.diagnosticMessage === right.diagnosticMessage &&
      left.permissions?.accessibility === right.permissions?.accessibility &&
      left.permissions?.screenRecording ===
        right.permissions?.screenRecording &&
      left.permissions?.screenRecordingCapturable ===
        right.permissions?.screenRecordingCapturable &&
      left.permissions?.source === right.permissions?.source)
  );
}

export interface DesktopComputerUseActionResult {
  success: boolean;
  output: string;
}

export type DesktopComputerUsePermissionPane =
  | "accessibility"
  | "screen-recording"
  | "privacy";

export interface DesktopComputerUsePermissionGrantStatus {
  id: "computer-use-permission-grant";
  running: boolean;
  startedAtUnixMs: number;
  elapsedMs: number;
  result?: DesktopComputerUseActionResult;
}

export interface DesktopComputerUseRestartDriverInput {
  // Restart even while a permission grant is still confirming. Used by the
  // wizard's explicit re-check, where the user has finished granting.
  force?: boolean;
}

export interface DesktopComputerUseRestartDriverResult {
  result: DesktopComputerUseActionResult;
  status: DesktopComputerUseStatus;
}

export interface DesktopInvokePayloadByChannel {
  [desktopIpcChannels.computerUse.checkStatus]: undefined;
  [desktopIpcChannels.computerUse.install]: undefined;
  [desktopIpcChannels.computerUse.uninstall]: undefined;
  [desktopIpcChannels.computerUse.grantPermissions]: undefined;
  [desktopIpcChannels.computerUse.startPermissionGrant]: undefined;
  [desktopIpcChannels.computerUse.getPermissionGrantStatus]: undefined;
  [desktopIpcChannels.computerUse
    .openPermissionSettings]: DesktopComputerUsePermissionPane;
  [desktopIpcChannels.computerUse.restartDriver]:
    | DesktopComputerUseRestartDriverInput
    | undefined;
  [desktopIpcChannels.appContext.get]: undefined;
  [desktopIpcChannels.appExternal.activityReportActive]: undefined;
  [desktopIpcChannels.appExternal
    .agentActivityActivateSession]: TuttiExternalAgentActivityActivateSessionInput;
  [desktopIpcChannels.appExternal
    .agentActivityCancelTurn]: TuttiExternalAgentActivityCancelTurnInput;
  [desktopIpcChannels.appExternal
    .agentActivityGetComposerOptions]: TuttiExternalAgentActivityComposerOptionsInput;
  [desktopIpcChannels.appExternal.agentActivityGetSnapshot]: undefined;
  [desktopIpcChannels.appExternal.agentActivityListTargets]: undefined;
  [desktopIpcChannels.appExternal
    .agentActivitySendInput]: TuttiExternalAgentActivitySendInput;
  [desktopIpcChannels.appExternal.atQuery]: TuttiExternalAtQueryInput;
  [desktopIpcChannels.appExternal.atResolve]: TuttiExternalAtResolveInput;
  [desktopIpcChannels.appExternal.filesOpen]: TuttiExternalFileOpenInput;
  [desktopIpcChannels.appExternal.filesSelect]: TuttiExternalFileSelectInput;
  [desktopIpcChannels.appExternal
    .filesUploadCancel]: DesktopWorkspaceAppFileUploadCancelInput;
  [desktopIpcChannels.appExternal
    .filesUploadComplete]: DesktopWorkspaceAppFileUploadCompleteInput;
  [desktopIpcChannels.appExternal
    .filesUploadPrepare]: DesktopWorkspaceAppFileUploadPrepareInput;
  [desktopIpcChannels.appExternal
    .permissionsRequest]: TuttiExternalPermissionRequestInput;
  [desktopIpcChannels.appExternal.pdfPrintHtml]: TuttiExternalPdfPrintHtmlInput;
  [desktopIpcChannels.appExternal
    .referencesOpen]: TuttiExternalReferenceOpenInput;
  [desktopIpcChannels.appExternal.settingsOpen]: TuttiExternalSettingsOpenInput;
  [desktopIpcChannels.appExternal
    .userProjectsCheckPath]: TuttiExternalUserProjectPathInput;
  [desktopIpcChannels.appExternal
    .userProjectsCreate]: TuttiExternalUserProjectCreateInput;
  [desktopIpcChannels.appExternal.userProjectsGetDefaultSelection]: undefined;
  [desktopIpcChannels.appExternal.userProjectsGetSnapshot]: undefined;
  [desktopIpcChannels.appExternal.userProjectsList]: undefined;
  [desktopIpcChannels.appExternal
    .userProjectsMove]: WorkspaceUserProjectMoveInput;
  [desktopIpcChannels.appExternal
    .userProjectsPrepareSelection]: WorkspaceUserProjectSelectionPreparationInput;
  [desktopIpcChannels.appExternal.userProjectsRefresh]: undefined;
  [desktopIpcChannels.appExternal
    .userProjectsRememberDefaultSelection]: TuttiExternalUserProjectRememberDefaultSelectionInput;
  [desktopIpcChannels.appExternal.userProjectsSelectDirectory]: undefined;
  [desktopIpcChannels.appExternal
    .userProjectsUse]: TuttiExternalUserProjectPathInput;
  [desktopIpcChannels.appExternal
    .workspaceFeatureOpen]: DesktopWorkspaceOpenFeatureRequest;
  [desktopIpcChannels.browser.activate]: BrowserNodeActivationInput;
  [desktopIpcChannels.browser.capturePreview]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.chooseDownloadDirectory]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.clearBrowsingData]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.close]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.findInPage]: BrowserNodeFindInPageInput;
  [desktopIpcChannels.browser.importCookies]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.goBack]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.goForward]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.navigate]: BrowserNodeNavigateInput;
  [desktopIpcChannels.browser.openDevTools]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.openExternal]: BrowserNodeOpenExternalInput;
  [desktopIpcChannels.browser
    .performDownloadAction]: BrowserNodeDownloadActionInput;
  [desktopIpcChannels.browser.prepareSession]: BrowserNodePrepareSessionInput;
  [desktopIpcChannels.browser.printPage]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.registerGuest]: BrowserNodeRegisterGuestInput;
  [desktopIpcChannels.browser.reload]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.saveScreenshot]: BrowserNodeSaveScreenshotInput;
  [desktopIpcChannels.browser
    .setDeviceEmulation]: BrowserNodeSetDeviceEmulationInput;
  [desktopIpcChannels.browser.setZoomFactor]: BrowserNodeSetZoomFactorInput;
  [desktopIpcChannels.browser
    .showDevToolsContextMenu]: BrowserNodeShowDevToolsContextMenuInput;
  [desktopIpcChannels.browser.stopFindInPage]: BrowserNodeStopFindInPageInput;
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
  [desktopIpcChannels.host.files.readLocalPreviewFile]: string;
  [desktopIpcChannels.host.files
    .archiveAgentPromptFile]: DesktopArchiveAgentPromptFileInput;
  [desktopIpcChannels.host.files
    .readPreviewFile]: DesktopWorkspaceFilePathPayload;
  [desktopIpcChannels.host.files
    .resolveEntryIcon]: DesktopWorkspaceFileEntryIconPayload;
  [desktopIpcChannels.host.files.selectAppArchive]: undefined;
  [desktopIpcChannels.host.files
    .selectAppArchiveExportPath]: DesktopSelectAppArchiveExportPathInput;
  [desktopIpcChannels.host.files.selectAppIconImage]: undefined;
  [desktopIpcChannels.host.files.selectDirectory]: undefined;
  [desktopIpcChannels.host.files.selectUploadFiles]:
    | DesktopSelectUploadFilesInput
    | undefined;
  [desktopIpcChannels.host.files
    .copyImageToClipboard]: DesktopClipboardImagePayload;
  [desktopIpcChannels.host.files.copyFilesToClipboard]: string[];
  [desktopIpcChannels.host.window.approveClose]: undefined;
  [desktopIpcChannels.host.window
    .capturePreview]: DesktopHostWindowCapturePreviewInput;
  [desktopIpcChannels.host.window.minimize]: undefined;
  [desktopIpcChannels.host.window
    .openAgentWindow]: DesktopHostOpenAgentWindowInput;
  [desktopIpcChannels.host.window
    .resizeContentWidth]: DesktopHostWindowResizeContentWidthInput;
  [desktopIpcChannels.host.window.toggleMaximize]: undefined;
  [desktopIpcChannels.host.workspace
    .openWorkspaceAppFolder]: DesktopWorkspaceAppPayload;
  [desktopIpcChannels.host.workspace
    .replaceWorkspaceWindow]: DesktopHostReplaceWorkspaceWindowInput;
  [desktopIpcChannels.host.workspace.showWorkspace]: string;
  [desktopIpcChannels.host.notifications.show]: DesktopHostNotificationPayload;
}

export interface DesktopInvokeResultByChannel {
  [desktopIpcChannels.computerUse.checkStatus]: DesktopComputerUseStatus;
  [desktopIpcChannels.computerUse.install]: DesktopComputerUseActionResult;
  [desktopIpcChannels.computerUse.uninstall]: DesktopComputerUseActionResult;
  [desktopIpcChannels.computerUse
    .grantPermissions]: DesktopComputerUseActionResult;
  [desktopIpcChannels.computerUse
    .startPermissionGrant]: DesktopComputerUsePermissionGrantStatus;
  [desktopIpcChannels.computerUse
    .getPermissionGrantStatus]: DesktopComputerUsePermissionGrantStatus | null;
  [desktopIpcChannels.computerUse.openPermissionSettings]: void;
  [desktopIpcChannels.computerUse
    .restartDriver]: DesktopComputerUseRestartDriverResult;
  [desktopIpcChannels.appContext.get]: DesktopWorkspaceAppContext;
  [desktopIpcChannels.appExternal.activityReportActive]: void;
  [desktopIpcChannels.appExternal
    .agentActivityActivateSession]: TuttiExternalAgentActivityActivateSessionResult;
  [desktopIpcChannels.appExternal
    .agentActivityCancelTurn]: TuttiExternalAgentActivityCancelTurnResult;
  [desktopIpcChannels.appExternal
    .agentActivityGetComposerOptions]: TuttiExternalAgentActivityComposerOptions;
  [desktopIpcChannels.appExternal
    .agentActivityGetSnapshot]: TuttiExternalAgentActivitySnapshot;
  [desktopIpcChannels.appExternal
    .agentActivityListTargets]: TuttiExternalAgentTargetCatalog;
  [desktopIpcChannels.appExternal
    .agentActivitySendInput]: TuttiExternalAgentActivitySendResult;
  [desktopIpcChannels.appExternal.atQuery]: TuttiExternalAtQueryResult[];
  [desktopIpcChannels.appExternal
    .atResolve]: TuttiExternalAtResolveResult | null;
  [desktopIpcChannels.appExternal.filesOpen]: void;
  [desktopIpcChannels.appExternal.filesSelect]: TuttiExternalFileSelectResult;
  [desktopIpcChannels.appExternal.filesUploadCancel]: void;
  [desktopIpcChannels.appExternal
    .filesUploadComplete]: TuttiExternalUploadedFile;
  [desktopIpcChannels.appExternal
    .filesUploadPrepare]: DesktopWorkspaceAppFileUploadPrepareResult;
  [desktopIpcChannels.appExternal
    .permissionsRequest]: TuttiExternalPermissionRequestResult;
  [desktopIpcChannels.appExternal
    .pdfPrintHtml]: TuttiExternalPdfPrintHtmlResult;
  [desktopIpcChannels.appExternal.referencesOpen]: void;
  [desktopIpcChannels.appExternal.settingsOpen]: void;
  [desktopIpcChannels.appExternal
    .userProjectsCheckPath]: WorkspaceUserProjectPathCheck;
  [desktopIpcChannels.appExternal.userProjectsCreate]: WorkspaceUserProject;
  [desktopIpcChannels.appExternal
    .userProjectsGetDefaultSelection]: WorkspaceUserProjectDefaultSelection | null;
  [desktopIpcChannels.appExternal
    .userProjectsGetSnapshot]: WorkspaceUserProjectServiceSnapshot;
  [desktopIpcChannels.appExternal.userProjectsList]: {
    projects: WorkspaceUserProject[];
  };
  [desktopIpcChannels.appExternal.userProjectsMove]: void;
  [desktopIpcChannels.appExternal
    .userProjectsPrepareSelection]: WorkspaceUserProjectSelectionPreparation;
  [desktopIpcChannels.appExternal
    .userProjectsRefresh]: WorkspaceUserProjectServiceSnapshot;
  [desktopIpcChannels.appExternal.userProjectsRememberDefaultSelection]: void;
  [desktopIpcChannels.appExternal.userProjectsSelectDirectory]: {
    path: string;
  } | null;
  [desktopIpcChannels.appExternal.userProjectsUse]: WorkspaceUserProject;
  [desktopIpcChannels.appExternal.workspaceFeatureOpen]: void;
  [desktopIpcChannels.browser.activate]: void;
  [desktopIpcChannels.browser.capturePreview]: string | null;
  [desktopIpcChannels.browser
    .chooseDownloadDirectory]: BrowserNodeDownloadDirectoryResult;
  [desktopIpcChannels.browser.clearBrowsingData]: void;
  [desktopIpcChannels.browser.close]: void;
  [desktopIpcChannels.browser.findInPage]: void;
  [desktopIpcChannels.browser.importCookies]: BrowserNodeCookieImportResult;
  [desktopIpcChannels.browser.goBack]: void;
  [desktopIpcChannels.browser.goForward]: void;
  [desktopIpcChannels.browser.navigate]: void;
  [desktopIpcChannels.browser.openDevTools]: void;
  [desktopIpcChannels.browser.openExternal]: void;
  [desktopIpcChannels.browser.performDownloadAction]: void;
  [desktopIpcChannels.browser.prepareSession]: void;
  [desktopIpcChannels.browser.printPage]: void;
  [desktopIpcChannels.browser.registerGuest]: void;
  [desktopIpcChannels.browser.reload]: void;
  [desktopIpcChannels.browser.saveScreenshot]: BrowserNodeScreenshotSaveResult;
  [desktopIpcChannels.browser.setDeviceEmulation]: void;
  [desktopIpcChannels.browser.setZoomFactor]: void;
  [desktopIpcChannels.browser.showDevToolsContextMenu]: void;
  [desktopIpcChannels.browser.stopFindInPage]: void;
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
  [desktopIpcChannels.host.files.readLocalPreviewFile]: Uint8Array;
  [desktopIpcChannels.host.files
    .archiveAgentPromptFile]: DesktopArchiveAgentPromptFileResult;
  [desktopIpcChannels.host.files.readPreviewFile]: Uint8Array;
  [desktopIpcChannels.host.files.resolveEntryIcon]: string | null;
  [desktopIpcChannels.host.files.selectAppArchive]: string | null;
  [desktopIpcChannels.host.files.selectAppArchiveExportPath]: string | null;
  [desktopIpcChannels.host.files.selectAppIconImage]: string | null;
  [desktopIpcChannels.host.files.selectDirectory]: string | null;
  [desktopIpcChannels.host.files.selectUploadFiles]: string[];
  [desktopIpcChannels.host.files.copyImageToClipboard]: void;
  [desktopIpcChannels.host.files.copyFilesToClipboard]: void;
  [desktopIpcChannels.host.window.approveClose]: void;
  [desktopIpcChannels.host.window.capturePreview]: string | null;
  [desktopIpcChannels.host.window.minimize]: void;
  [desktopIpcChannels.host.window.openAgentWindow]: void;
  [desktopIpcChannels.host.window
    .resizeContentWidth]: DesktopHostWindowResizeContentWidthResult;
  [desktopIpcChannels.host.window.toggleMaximize]: void;
  [desktopIpcChannels.host.workspace.openWorkspaceAppFolder]: void;
  [desktopIpcChannels.host.workspace.replaceWorkspaceWindow]: void;
  [desktopIpcChannels.host.workspace.showWorkspace]: void;
  [desktopIpcChannels.host.notifications.show]: DesktopHostNotificationResult;
}

export type DesktopInvokeChannel = keyof DesktopInvokePayloadByChannel;
