import type {
  TerminalTransportAttachInput,
  CopyWorkspacePathInput,
  ListSystemFontsResult,
  TerminalTransportDetachInput,
  EnsureDirectoryInput,
  ListAgentModelsInput,
  ListAgentModelsResult,
  ListInstalledAgentProvidersResult,
  ListTerminalProfilesResult,
  AppUpdateState,
  ConfigureAppUpdatesInput,
  PersistWriteResult,
  ReadAppStateResult,
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  WriteWorkspaceFileTextInput,
  WriteWorkspaceFileInput,
  WindowDisplayInfo,
  ReadAgentNodePlaceholderScrollbackInput,
  ReadNodeScrollbackInput,
  ReadWorkspaceAgentReadStateInput,
  WorkspaceAgentReadStateSnapshot,
  ReadRoomCanvasStateInput,
  TerminalTransportResizeInput,
  TerminalTransportSnapshotInput,
  TerminalTransportSnapshotResult,
  ShellDarwinNativeTrafficLightsVisibleInput,
  ShellDarwinTrafficLightsLayoutInput,
  SetWindowChromeThemeInput,
  TerminalTransportDataEvent,
  TerminalTransportExitEvent,
  TerminalTransportSessionMetadataEvent,
  TerminalTransportSessionStateEvent,
  WorkspaceContextSelection,
  WorkspaceDirectory,
  WorkspaceFileSelection,
  WriteAppStateInput,
  WriteAgentNodePlaceholderScrollbackInput,
  WriteNodeScrollbackInput,
  WriteWorkspaceAgentReadStateInput,
  WriteRoomCanvasStateInput,
  WriteWorkspaceStateRawInput,
  TerminalTransportWriteInput,
  CopyEntryInput,
  RuntimeDiagnosticsLogInput,
  TerminalDiagnosticsLogInput,
  CreateDirectoryInput,
  DeleteEntryInput,
  MoveEntryInput,
  ReadDirectoryInput,
  ReadDirectoryResult,
  ReadFileBytesInput,
  ReadFileBytesResult,
  ReadFileTextInput,
  ReadFileTextResult,
  RenameEntryInput,
  StatInput,
  FileSystemStat,
  SyncEventPayload,
  WriteFileTextInput,
  ActivateWebsiteWindowInput,
  WebsiteWindowDebugDump,
  NavigateWebsiteWindowInput,
  PrepareWebsiteWindowSessionInput,
  RegisterWebsiteWindowGuestInput,
  SetWebsiteWindowOccludedInput,
  UnregisterWebsiteWindowGuestInput,
  WebsiteWindowEventPayload,
  WebsiteWindowNodeIdInput,
  ClearLogsResult,
  DoctorCliInstallState,
  ExportLogsResult,
  InstallDoctorCliResult,
  SystemLogsSummaryResult
} from "../../../shared/contracts/dto";

type UnsubscribeFn = () => void;

export interface AgentHostPreloadApi {
  meta: {
    isTest: boolean;
    isPackaged: boolean;
    allowWhatsNewInTests: boolean;
    enableTerminalDiagnostics?: boolean;
    enableTerminalInputDiagnostics?: boolean;
    enableWorkspaceSurfaceDiagnostics?: boolean;
    runtime: "electron" | "browser";
    appVersion?: string | null;
    platform: string;
    /** macOS custom caption bar: main hides traffic lights and renderer draws min/max/close. */
    hostCaptionControls: boolean;
    workspaceId: string | null;
    pendingWorkspaceRequestId: string | null;
    pendingWorkspaceIssueNavigation: {
      workspaceId: string;
      issueId?: string | null;
    } | null;
    mainPid: number | null;
    windowsPty:
      | import("../../../shared/contracts/dto").TerminalWindowsPty
      | null;
  };
  debug?: {
    logTerminalDiagnostics: (payload: TerminalDiagnosticsLogInput) => void;
    logRuntimeDiagnostics: (payload: RuntimeDiagnosticsLogInput) => void;
  };
  windowChrome: {
    setTheme: (payload: SetWindowChromeThemeInput) => Promise<void>;
    closeCurrentWindow: () => Promise<void>;
  };
  shellHost: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    setDarwinTrafficLightsLayout: (
      payload: ShellDarwinTrafficLightsLayoutInput
    ) => Promise<void>;
    setDarwinNativeTrafficLightsVisible: (
      payload: ShellDarwinNativeTrafficLightsVisibleInput
    ) => Promise<void>;
  };
  windowMetrics: {
    getDisplayInfo: () => Promise<WindowDisplayInfo>;
  };
  clipboard: {
    readText: () => Promise<string>;
    writeText: (text: string) => Promise<void>;
  };
  filesystem: {
    createDirectory: (payload: CreateDirectoryInput) => Promise<void>;
    copyEntry: (payload: CopyEntryInput) => Promise<void>;
    moveEntry: (payload: MoveEntryInput) => Promise<void>;
    renameEntry: (payload: RenameEntryInput) => Promise<void>;
    deleteEntry: (payload: DeleteEntryInput) => Promise<void>;
    readFileBytes: (
      payload: ReadFileBytesInput
    ) => Promise<ReadFileBytesResult>;
    readFileText: (payload: ReadFileTextInput) => Promise<ReadFileTextResult>;
    writeFileText: (payload: WriteFileTextInput) => Promise<void>;
    readDirectory: (
      payload: ReadDirectoryInput
    ) => Promise<ReadDirectoryResult>;
    stat: (payload: StatInput) => Promise<FileSystemStat>;
  };
  persistence: {
    readWorkspaceStateRaw: () => Promise<string | null>;
    writeWorkspaceStateRaw: (
      payload: WriteWorkspaceStateRawInput
    ) => Promise<PersistWriteResult>;
    readAppState: () => Promise<ReadAppStateResult>;
    writeAppState: (payload: WriteAppStateInput) => Promise<PersistWriteResult>;
    readRoomCanvasState: (
      payload: ReadRoomCanvasStateInput
    ) => Promise<string | null>;
    writeRoomCanvasState: (
      payload: WriteRoomCanvasStateInput
    ) => Promise<PersistWriteResult>;
    readWorkspaceAgentReadState: (
      payload: ReadWorkspaceAgentReadStateInput
    ) => Promise<WorkspaceAgentReadStateSnapshot>;
    writeWorkspaceAgentReadState: (
      payload: WriteWorkspaceAgentReadStateInput
    ) => Promise<PersistWriteResult>;
    readNodeScrollback: (
      payload: ReadNodeScrollbackInput
    ) => Promise<string | null>;
    writeNodeScrollback: (
      payload: WriteNodeScrollbackInput
    ) => Promise<PersistWriteResult>;
    readAgentNodePlaceholderScrollback: (
      payload: ReadAgentNodePlaceholderScrollbackInput
    ) => Promise<string | null>;
    writeAgentNodePlaceholderScrollback: (
      payload: WriteAgentNodePlaceholderScrollbackInput
    ) => Promise<PersistWriteResult>;
  };
  lifecycle: {
    onRequestPersistFlush: (
      listener: (payload: { requestId: string }) => void | Promise<void>
    ) => UnsubscribeFn;
    onRequestWindowClose: (
      listener: (payload: { requestId: string }) => boolean | Promise<boolean>
    ) => UnsubscribeFn;
  };
  sync: {
    onStateUpdated: (
      listener: (event: SyncEventPayload) => void
    ) => UnsubscribeFn;
  };
  websiteWindow: {
    prepareSession: (
      payload: PrepareWebsiteWindowSessionInput
    ) => Promise<void>;
    registerGuest: (payload: RegisterWebsiteWindowGuestInput) => Promise<void>;
    unregisterGuest: (
      payload: UnregisterWebsiteWindowGuestInput
    ) => Promise<void>;
    setOccluded: (payload: SetWebsiteWindowOccludedInput) => Promise<void>;
    activate: (payload: ActivateWebsiteWindowInput) => Promise<void>;
    navigate: (payload: NavigateWebsiteWindowInput) => Promise<void>;
    goBack: (payload: WebsiteWindowNodeIdInput) => Promise<void>;
    goForward: (payload: WebsiteWindowNodeIdInput) => Promise<void>;
    reload: (payload: WebsiteWindowNodeIdInput) => Promise<void>;
    close: (payload: WebsiteWindowNodeIdInput) => Promise<void>;
    debugDump: (
      payload: WebsiteWindowNodeIdInput
    ) => Promise<WebsiteWindowDebugDump | null>;
    onEvent: (
      listener: (event: WebsiteWindowEventPayload) => void
    ) => UnsubscribeFn;
  };
  workspace: {
    selectDirectory: () => Promise<WorkspaceDirectory | null>;
    selectFiles: (input?: {
      allowDirectories?: boolean;
    }) => Promise<WorkspaceFileSelection[]>;
    selectContextEntries: () => Promise<WorkspaceContextSelection>;
    ensureDirectory: (payload: EnsureDirectoryInput) => Promise<void>;
    getReferenceForFile?: (file: File) => {
      kind: "file" | "folder";
      path: string;
    };
    readFile: (
      payload: ReadWorkspaceFileInput
    ) => Promise<ReadWorkspaceFileResult>;
    writeFile: (payload: WriteWorkspaceFileInput) => Promise<void>;
    writeFileText: (payload: WriteWorkspaceFileTextInput) => Promise<void>;
    copyPath: (payload: CopyWorkspacePathInput) => Promise<void>;
  };
  update: {
    getState: () => Promise<AppUpdateState>;
    configure: (payload: ConfigureAppUpdatesInput) => Promise<AppUpdateState>;
    checkForUpdates: () => Promise<AppUpdateState>;
    downloadUpdate: () => Promise<AppUpdateState>;
    installUpdate: () => Promise<void>;
    onState: (listener: (state: AppUpdateState) => void) => UnsubscribeFn;
  };
  terminalTransport: {
    listProfiles?: () => Promise<ListTerminalProfilesResult>;
    write: (payload: TerminalTransportWriteInput) => Promise<void>;
    resize: (payload: TerminalTransportResizeInput) => Promise<void>;
    attach: (payload: TerminalTransportAttachInput) => Promise<void>;
    detach: (payload: TerminalTransportDetachInput) => Promise<void>;
    snapshot: (
      payload: TerminalTransportSnapshotInput
    ) => Promise<TerminalTransportSnapshotResult>;
    onData: (
      listener: (event: TerminalTransportDataEvent) => void
    ) => UnsubscribeFn;
    onExit: (
      listener: (event: TerminalTransportExitEvent) => void
    ) => UnsubscribeFn;
    onState: (
      listener: (event: TerminalTransportSessionStateEvent) => void
    ) => UnsubscribeFn;
    onMetadata: (
      listener: (event: TerminalTransportSessionMetadataEvent) => void
    ) => UnsubscribeFn;
  };
  agent: {
    listModels: (
      payload: ListAgentModelsInput
    ) => Promise<ListAgentModelsResult>;
    listInstalledProviders: () => Promise<ListInstalledAgentProvidersResult>;
  };
  system: {
    listFonts: () => Promise<ListSystemFontsResult>;
    exportLogs: () => Promise<ExportLogsResult>;
    getLogsSummary: () => Promise<SystemLogsSummaryResult>;
    clearLogs: () => Promise<ClearLogsResult>;
    getDoctorCliInstallState: () => Promise<DoctorCliInstallState>;
    installDoctorCli: () => Promise<InstallDoctorCliResult>;
  };
}

export interface DebugWindowApi {
  ipcInspector: {
    listRecords: () => Promise<
      import("../../../shared/contracts/dto").IpcInspectorRecord[]
    >;
    subscribeRecords: (
      listener: (
        records: import("../../../shared/contracts/dto").IpcInspectorRecord[]
      ) => void
    ) => () => void;
    clearRecords: () => Promise<void>;
    exportRecords: () => Promise<
      import("../../../shared/contracts/dto").IpcInspectorExportResult
    >;
  };
  windowControls: {
    getPinned: () => Promise<boolean>;
    setPinned: (pinned: boolean) => Promise<boolean>;
  };
}

declare global {
  interface Window {
    agentHostApi: AgentHostPreloadApi;
    tshAgentGuiDiagnostics?: {
      download: () => Promise<ExportLogsResult>;
      clear: () => Promise<ClearLogsResult>;
      summary: () => Promise<SystemLogsSummaryResult>;
      help: () => string;
    };
    downloadAgentGuiDiagnostics?: () => Promise<ExportLogsResult>;
    clearAgentGuiDiagnostics?: () => Promise<ClearLogsResult>;
    tshDebugWindowApi?: DebugWindowApi;
  }
}
