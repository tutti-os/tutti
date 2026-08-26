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
  DesktopPreferencesStateResponse,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type {
  BrowserNodeActivationInput,
  BrowserNodeChromeCookieImportInput,
  BrowserNodeCancelChromeCookieImportInput,
  BrowserNodeChromeProfileDiscoveryResult,
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
  BrowserNodeUnregisterGuestInput,
  BrowserNodeUpdateAutomationTargetInput
} from "@tutti-os/browser-node";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import type {
  DesktopCaptureComposerOptions,
  DesktopCaptureComposerOptionsInput,
  DesktopCaptureRememberComposerDefaultsInput,
  DesktopCaptureSelectionInput,
  DesktopCaptureSelectionResult,
  DesktopCaptureState,
  DesktopCaptureSubmitInput,
  DesktopCaptureSubmitResult
} from "./capture.ts";
import type {
  TuttiExternalAtQueryDirectoryInput,
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
  TuttiExternalReferenceSelectResult,
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
  TuttiExternalAgentActivityRememberComposerDefaultsInput,
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
  capture: {
    cancel: "capture:cancel",
    getComposerOptions: "capture:get-composer-options",
    getState: "capture:get-state",
    queryMentionDirectory: "capture:query-mention-directory",
    queryMentions: "capture:query-mentions",
    rememberComposerDefaults: "capture:remember-composer-defaults",
    resolveMention: "capture:resolve-mention",
    select: "capture:select",
    selectFiles: "capture:select-files",
    selectProjectDirectory: "capture:select-project-directory",
    userProjectsList: "capture:user-projects:list",
    userProjectsPrepareSelection: "capture:user-projects:prepare-selection",
    userProjectsUse: "capture:user-projects:use",
    submit: "capture:submit"
  },
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
    agentActivityRememberComposerDefaults:
      "workspace-app-agent-activity:remember-composer-defaults",
    agentActivitySendInput: "workspace-app-agent-activity:send-input",
    atQuery: "workspace-app-at:query",
    atQueryDirectory: "workspace-app-at:query-directory",
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
    referencesSelect: "workspace-app-references:select",
    guestEvent: "workspace-app-external:guest-event",
    rendererEvent: "workspace-app-external:renderer-event",
    rendererReady: "workspace-app-external:renderer-ready",
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
    userProjectsRemove: "workspace-app-user-projects:remove",
    userProjectsPrepareSelection:
      "workspace-app-user-projects:prepare-selection",
    userProjectsRefresh: "workspace-app-user-projects:refresh",
    userProjectsRememberDefaultSelection:
      "workspace-app-user-projects:remember-default-selection",
    userProjectsSelectDirectory: "workspace-app-user-projects:select-directory",
    userProjectsUse: "workspace-app-user-projects:use",
    workspaceFeatureOpen: "workspace-app-feature:open"
  },
  workspaceApp: {
    popupRejected: "workspace-app-popup:rejected"
  },
  browser: {
    activate: "browser:activate",
    automationHostReady: "browser:automation-host-ready",
    automationRequest: "browser:automation-request",
    automationResponse: "browser:automation-response",
    automationTurnClaim: "browser:automation-turn-claim",
    capturePreview: "browser:capturePreview",
    chooseDownloadDirectory: "browser:chooseDownloadDirectory",
    clearBrowsingData: "browser:clearBrowsingData",
    cancelChromeCookieImport: "browser:cancelChromeCookieImport",
    close: "browser:close",
    event: "browser:event",
    findInPage: "browser:findInPage",
    discoverChromeCookieProfiles: "browser:discoverChromeCookieProfiles",
    importCookies: "browser:importCookies",
    importChromeCookies: "browser:importChromeCookies",
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
    unregisterGuest: "browser:unregisterGuest",
    updateAutomationTarget: "browser:updateAutomationTarget"
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
    getAgentSessionReplayPlayback: "runtime:getAgentSessionReplayPlayback",
    getAgentSessionReplayStatus: "runtime:getAgentSessionReplayStatus",
    importAgentSessionReplayCassettes:
      "runtime:importAgentSessionReplayCassettes",
    getBackendConfig: "runtime:getBackendConfig",
    getBusinessEventStreamUrl: "runtime:getBusinessEventStreamUrl",
    launchAgentSessionReplay: "runtime:launchAgentSessionReplay",
    listWorkspaceAgentProbes: "runtime:listWorkspaceAgentProbes",
    logRendererDiagnostic: "runtime:logRendererDiagnostic",
    revealAgentSessionReplayCassette:
      "runtime:revealAgentSessionReplayCassette",
    sendAgentSessionReplayControl: "runtime:sendAgentSessionReplayControl",
    getTerminalStreamUrl: "runtime:getTerminalStreamUrl",
    logTerminalDiagnostic: "runtime:logTerminalDiagnostic",
    setAgentSessionReplayPlayback: "runtime:setAgentSessionReplayPlayback",
    waitForAgentSessionReplay: "runtime:waitForAgentSessionReplay"
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
    preferences: {
      ensureInitialized: "host:preferences:ensureInitialized"
    },
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
      setCloseGuardEnabled: "host:window:setCloseGuardEnabled",
      capturePreview: "host:window:capturePreview",
      capturePreviewImages: "host:window:capturePreviewImages",
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

export interface DesktopHostWindowPreviewImages {
  dockPreviewImageUrl: string;
  genieImageUrl: string;
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
  reason: "native-window-close" | "quit" | "window-close";
}

export interface DesktopHostWindowCloseGuardInput {
  enabled: boolean;
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
  clientTs: number;
  mode: "agent" | "os";
  previousMode: "agent" | "os";
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

export interface DesktopLaunchAgentSessionReplayCassette {
  cassetteDirectory: string;
  rootAgentSessionId: string;
  cassetteId: string;
}

export interface DesktopLaunchAgentSessionReplayInput {
  launchId: string;
  cassettes: DesktopLaunchAgentSessionReplayCassette[];
  playbackMode: DesktopAgentSessionReplayLaunchPlaybackMode;
  workspaceId: string;
}

export type DesktopAgentSessionReplayLaunchPlaybackMode =
  | "automatic"
  | "manual";

export interface DesktopLaunchAgentSessionReplayResult {
  launchId: string;
  cassetteIds: string[];
  workspaceId: string;
}

export interface DesktopRevealAgentSessionReplayCassetteInput {
  cassetteId: string;
  workspaceId: string;
}

export interface DesktopImportAgentSessionReplayCassettesInput {
  workspaceId: string;
}

export interface DesktopImportAgentSessionReplayCassettesResult {
  canceled: boolean;
  failedCount: number;
  importedCount: number;
}

export type DesktopAgentSessionReplayPlaybackSpeed = 0.25 | 0.5 | 1 | 2 | 4;

export interface DesktopAgentSessionReplayPlayback {
  active: boolean;
  paused: boolean;
  playbackElapsedMs: number;
  speed: DesktopAgentSessionReplayPlaybackSpeed;
  timingMode: DesktopAgentSessionReplayTimingMode;
}

export interface DesktopGetAgentSessionReplayPlaybackInput {
  cassetteId: string;
}

export interface DesktopGetAgentSessionReplayStatusInput {
  cassetteId: string;
}

export type DesktopAgentSessionReplayTimingMode = "realtime" | "fast-forward";

export type DesktopAgentSessionReplayPhase =
  | "replaying"
  | "verifying"
  | "complete"
  | "failed";

export interface DesktopAgentSessionReplayFailureCause {
  code: string;
  message: string;
}

export interface DesktopAgentSessionReplayStatus {
  active: boolean;
  cassetteId?: string;
  cassettes?: Array<{
    id: string;
    name: string;
  }>;
  currentCheckpoint?: number;
  errorCause?: DesktopAgentSessionReplayFailureCause;
  errorMessage?: string;
  paused?: boolean;
  phase?: DesktopAgentSessionReplayPhase;
  targetCheckpoint?: number | null;
  timingMode?: DesktopAgentSessionReplayTimingMode;
  totalDurationMs?: number;
  totalCheckpoints?: number;
}

export type DesktopSetAgentSessionReplayPlaybackInput =
  | {
      command: "set-speed";
      cassetteId: string;
      speed: DesktopAgentSessionReplayPlaybackSpeed;
    }
  | {
      command: "pause" | "resume";
      cassetteId: string;
    }
  | {
      command: "set-timing-mode";
      cassetteId: string;
      timingMode: DesktopAgentSessionReplayTimingMode;
    };

export interface DesktopSendAgentSessionReplayControlInput {
  command: "next-checkpoint" | "pause" | "resume";
  cassetteId: string;
}

export interface DesktopWaitAgentSessionReplayInput {
  cassetteId: string;
  launchId: string;
}

export interface DesktopWaitAgentSessionReplayResult {
  cassetteId: string;
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
  revision?: string | null;
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
  | TuttiExternalReferenceSelectResult
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

export interface DesktopWorkspaceAppExternalRendererReadiness {
  ready: boolean;
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

export const desktopDeveloperLogsExportScopes = [
  "recent-10-minutes",
  "recent-3-days"
] as const;

export type DesktopDeveloperLogsExportScope =
  (typeof desktopDeveloperLogsExportScopes)[number];

export interface ExportDeveloperLogsInput {
  includeAgentSessions: boolean;
  scope: DesktopDeveloperLogsExportScope;
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

/** The native capability used to report computer-use readiness. */
export type DesktopComputerUsePlatform = "darwin" | "win32" | "unknown";

export type DesktopComputerUseStatusReason =
  | "driver-daemon-not-running"
  | "driver-doctor-failed"
  | "not-installed"
  | "permission-missing"
  | "screen-recording-not-capturable"
  | "status-command-failed"
  | "status-unparseable";

export interface DesktopComputerUseStatus {
  installed: boolean;
  /** Optional for compatibility with older preload clients. */
  platform?: DesktopComputerUsePlatform;
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
      left.platform === right.platform &&
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

export type DesktopComputerUseActionFailureReason =
  | "timeout"
  | "spawn-error"
  | "exit-code";

export interface DesktopComputerUseActionResult {
  success: boolean;
  output: string;
  /** The child-process exit code, when the process reached close normally. */
  exitCode?: number | null;
  /** A stable reason that lets the renderer distinguish common failures. */
  failureReason?: DesktopComputerUseActionFailureReason;
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

export interface DesktopBrowserAutomationRequest {
  action: "create" | "select" | "close";
  agentSessionId: string | null;
  agentTurnId?: string | null;
  nodeId: string | null;
  /** Whether this create request should reveal its Browser surface. */
  reveal?: boolean;
  requestId: string;
  surfaceRole: "agent" | "user";
  url: string | null;
  workspaceId: string;
}

export interface DesktopBrowserAutomationHostReady {
  surfaceRole: "agent" | "user";
  workspaceId: string;
}

export interface DesktopBrowserAutomationTurnClaim {
  agentSessionId: string;
  agentTurnId: string;
  workspaceId: string;
}

export interface DesktopWorkspaceAppPopupRejectedEvent {
  reason: "deferred-navigation-unsupported" | "post-unsupported";
}

export type DesktopBrowserAutomationResponse =
  | {
      nodeId: string | null;
      ok: true;
      requestId: string;
    }
  | {
      error: string;
      ok: false;
      requestId: string;
    };

export interface DesktopInvokePayloadByChannel {
  [desktopIpcChannels.capture.cancel]: undefined;
  [desktopIpcChannels.capture
    .getComposerOptions]: DesktopCaptureComposerOptionsInput;
  [desktopIpcChannels.capture.getState]: undefined;
  [desktopIpcChannels.capture
    .queryMentionDirectory]: TuttiExternalAtQueryDirectoryInput;
  [desktopIpcChannels.capture.queryMentions]: TuttiExternalAtQueryInput;
  [desktopIpcChannels.capture
    .rememberComposerDefaults]: DesktopCaptureRememberComposerDefaultsInput;
  [desktopIpcChannels.capture.resolveMention]: TuttiExternalAtResolveInput;
  [desktopIpcChannels.capture.select]: DesktopCaptureSelectionInput;
  [desktopIpcChannels.capture.selectFiles]: undefined;
  [desktopIpcChannels.capture.selectProjectDirectory]: undefined;
  [desktopIpcChannels.capture.userProjectsList]: undefined;
  [desktopIpcChannels.capture
    .userProjectsPrepareSelection]: WorkspaceUserProjectSelectionPreparationInput;
  [desktopIpcChannels.capture
    .userProjectsUse]: TuttiExternalUserProjectPathInput;
  [desktopIpcChannels.capture.submit]: DesktopCaptureSubmitInput;
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
    .agentActivityRememberComposerDefaults]: TuttiExternalAgentActivityRememberComposerDefaultsInput;
  [desktopIpcChannels.appExternal
    .agentActivitySendInput]: TuttiExternalAgentActivitySendInput;
  [desktopIpcChannels.appExternal.atQuery]: TuttiExternalAtQueryInput;
  [desktopIpcChannels.appExternal
    .atQueryDirectory]: TuttiExternalAtQueryDirectoryInput;
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
  [desktopIpcChannels.appExternal.referencesSelect]: undefined;
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
    .userProjectsRemove]: TuttiExternalUserProjectPathInput;
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
  [desktopIpcChannels.browser
    .cancelChromeCookieImport]: BrowserNodeCancelChromeCookieImportInput;
  [desktopIpcChannels.browser.close]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser.findInPage]: BrowserNodeFindInPageInput;
  [desktopIpcChannels.browser.discoverChromeCookieProfiles]: undefined;
  [desktopIpcChannels.browser.importCookies]: BrowserNodeNodeIdInput;
  [desktopIpcChannels.browser
    .importChromeCookies]: BrowserNodeChromeCookieImportInput;
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
  [desktopIpcChannels.browser
    .updateAutomationTarget]: BrowserNodeUpdateAutomationTargetInput;
  [desktopIpcChannels.dockPreviewCache.read]: DesktopReadDockPreviewInput;
  [desktopIpcChannels.dockPreviewCache.write]: DesktopWriteDockPreviewInput;
  [desktopIpcChannels.developer.clearLogs]: undefined;
  [desktopIpcChannels.developer.exportLogs]: ExportDeveloperLogsInput;
  [desktopIpcChannels.developer.getLogsState]: undefined;
  [desktopIpcChannels.developer.openLogDirectory]: undefined;
  [desktopIpcChannels.developer.openLogFile]: DesktopDeveloperLogKind;
  [desktopIpcChannels.runtime.getBackendConfig]: undefined;
  [desktopIpcChannels.runtime.getBusinessEventStreamUrl]: undefined;
  [desktopIpcChannels.runtime
    .getAgentSessionReplayPlayback]: DesktopGetAgentSessionReplayPlaybackInput;
  [desktopIpcChannels.runtime
    .getAgentSessionReplayStatus]: DesktopGetAgentSessionReplayStatusInput;
  [desktopIpcChannels.runtime
    .importAgentSessionReplayCassettes]: DesktopImportAgentSessionReplayCassettesInput;
  [desktopIpcChannels.runtime
    .launchAgentSessionReplay]: DesktopLaunchAgentSessionReplayInput;
  [desktopIpcChannels.runtime
    .revealAgentSessionReplayCassette]: DesktopRevealAgentSessionReplayCassetteInput;
  [desktopIpcChannels.runtime
    .waitForAgentSessionReplay]: DesktopWaitAgentSessionReplayInput;
  [desktopIpcChannels.runtime
    .listWorkspaceAgentProbes]: AgentProviderProbeListInput;
  [desktopIpcChannels.runtime
    .getTerminalStreamUrl]: DesktopTerminalStreamUrlRequest;
  [desktopIpcChannels.runtime
    .logRendererDiagnostic]: DesktopRendererDiagnosticPayload;
  [desktopIpcChannels.runtime
    .setAgentSessionReplayPlayback]: DesktopSetAgentSessionReplayPlaybackInput;
  [desktopIpcChannels.runtime
    .sendAgentSessionReplayControl]: DesktopSendAgentSessionReplayControlInput;
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
  [desktopIpcChannels.host.preferences.ensureInitialized]: undefined;
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
    .setCloseGuardEnabled]: DesktopHostWindowCloseGuardInput;
  [desktopIpcChannels.host.window
    .capturePreview]: DesktopHostWindowCapturePreviewInput;
  [desktopIpcChannels.host.window
    .capturePreviewImages]: DesktopHostWindowCapturePreviewInput;
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
  [desktopIpcChannels.capture.cancel]: void;
  [desktopIpcChannels.capture
    .getComposerOptions]: DesktopCaptureComposerOptions;
  [desktopIpcChannels.capture.getState]: DesktopCaptureState;
  [desktopIpcChannels.capture
    .queryMentionDirectory]: TuttiExternalAtQueryResult[];
  [desktopIpcChannels.capture.queryMentions]: TuttiExternalAtQueryResult[];
  [desktopIpcChannels.capture.rememberComposerDefaults]: void;
  [desktopIpcChannels.capture
    .resolveMention]: TuttiExternalAtResolveResult | null;
  [desktopIpcChannels.capture.select]: DesktopCaptureSelectionResult;
  [desktopIpcChannels.capture.selectFiles]: WorkspaceFileReference[];
  [desktopIpcChannels.capture.selectProjectDirectory]: { path: string } | null;
  [desktopIpcChannels.capture.userProjectsList]: {
    projects: WorkspaceUserProject[];
  };
  [desktopIpcChannels.capture
    .userProjectsPrepareSelection]: WorkspaceUserProjectSelectionPreparation;
  [desktopIpcChannels.capture.userProjectsUse]: WorkspaceUserProject;
  [desktopIpcChannels.capture.submit]: DesktopCaptureSubmitResult;
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
  [desktopIpcChannels.appExternal.agentActivityRememberComposerDefaults]: void;
  [desktopIpcChannels.appExternal
    .agentActivitySendInput]: TuttiExternalAgentActivitySendResult;
  [desktopIpcChannels.appExternal.atQuery]: TuttiExternalAtQueryResult[];
  [desktopIpcChannels.appExternal
    .atQueryDirectory]: TuttiExternalAtQueryResult[];
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
  [desktopIpcChannels.appExternal
    .referencesSelect]: TuttiExternalReferenceSelectResult;
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
  [desktopIpcChannels.appExternal.userProjectsRemove]: void;
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
  [desktopIpcChannels.browser.cancelChromeCookieImport]: void;
  [desktopIpcChannels.browser.close]: void;
  [desktopIpcChannels.browser.findInPage]: void;
  [desktopIpcChannels.browser
    .discoverChromeCookieProfiles]: BrowserNodeChromeProfileDiscoveryResult;
  [desktopIpcChannels.browser.importCookies]: BrowserNodeCookieImportResult;
  [desktopIpcChannels.browser
    .importChromeCookies]: BrowserNodeCookieImportResult;
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
  [desktopIpcChannels.browser.updateAutomationTarget]: void;
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
    .getAgentSessionReplayPlayback]: DesktopAgentSessionReplayPlayback;
  [desktopIpcChannels.runtime
    .getAgentSessionReplayStatus]: DesktopAgentSessionReplayStatus;
  [desktopIpcChannels.runtime
    .importAgentSessionReplayCassettes]: DesktopImportAgentSessionReplayCassettesResult;
  [desktopIpcChannels.runtime
    .launchAgentSessionReplay]: DesktopLaunchAgentSessionReplayResult;
  [desktopIpcChannels.runtime.revealAgentSessionReplayCassette]: void;
  [desktopIpcChannels.runtime
    .waitForAgentSessionReplay]: DesktopWaitAgentSessionReplayResult;
  [desktopIpcChannels.runtime
    .listWorkspaceAgentProbes]: AgentProviderProbeListResult;
  [desktopIpcChannels.runtime.getTerminalStreamUrl]: string;
  [desktopIpcChannels.runtime.logRendererDiagnostic]: void;
  [desktopIpcChannels.runtime
    .setAgentSessionReplayPlayback]: DesktopAgentSessionReplayPlayback;
  [desktopIpcChannels.runtime.sendAgentSessionReplayControl]: void;
  [desktopIpcChannels.runtime.logTerminalDiagnostic]: void;
  [desktopIpcChannels.update.check]: AppUpdateState;
  [desktopIpcChannels.update.configure]: AppUpdateState;
  [desktopIpcChannels.update.download]: AppUpdateState;
  [desktopIpcChannels.update.getState]: AppUpdateState;
  [desktopIpcChannels.update.install]: void;
  [desktopIpcChannels.wallpaper.clearCustom]: void;
  [desktopIpcChannels.wallpaper.getCustom]: DesktopCustomWallpaperImage | null;
  [desktopIpcChannels.wallpaper.setCustom]: DesktopCustomWallpaperImage;
  [desktopIpcChannels.host.preferences
    .ensureInitialized]: DesktopPreferencesStateResponse;
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
  [desktopIpcChannels.host.window.setCloseGuardEnabled]: void;
  [desktopIpcChannels.host.window.capturePreview]: string | null;
  [desktopIpcChannels.host.window
    .capturePreviewImages]: DesktopHostWindowPreviewImages | null;
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
