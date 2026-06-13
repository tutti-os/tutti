import type {
  AddIssueManagerContextRefsRequest,
  AgentProviderComposerOptionsResponse,
  AgentProviderProbeResponse,
  AgentProviderActionId,
  AgentProviderActionRunResponse,
  AgentProviderStatusListResponse,
  CancelWorkspaceAgentSessionResponse,
  CliCapabilitiesResponse,
  AgentSessionComposerSettings,
  GetAgentProviderComposerOptionsRequest,
  CompleteIssueManagerRunRequest,
  CheckUserProjectPathRequest,
  CreateIssueManagerIssueRequest,
  CreateIssueManagerRunRequest,
  CreateIssueManagerTaskRequest,
  CreateIssueManagerTopicRequest,
  CreateWorkspaceAgentSessionRequest,
  CreateWorkspaceAppFactoryJobRequest,
  CreateWorkspaceTerminalRequest,
  DeleteWorkspaceAgentSessionResponse,
  DeleteIssueManagerContextRefResponse,
  DeleteIssueManagerIssueResponse,
  DeleteIssueManagerTaskResponse,
  DeleteIssueManagerTopicResponse,
  DeleteWorkspaceFileEntryResponse,
  DeleteWorkspaceResponse,
  DeleteWorkspaceAppResponse,
  DeleteUserProjectRequest,
  DesktopPreferencesStateResponse,
  ExportWorkspaceAppRequest,
  ExportWorkspaceAppResponse,
  FixWorkspaceAppFactoryJobRequest,
  HealthStatusResponse,
  IssueManagerContextRefsResponse,
  IssueManagerIssue,
  IssueManagerIssueDetailResponse,
  IssueManagerIssueListResponse,
  IssueManagerRun,
  IssueManagerRunEnvelope,
  IssueManagerRunListResponse,
  IssueManagerStatus,
  IssueManagerTask,
  IssueManagerTaskDetailResponse,
  IssueManagerTaskListResponse,
  IssueManagerTopic,
  IssueManagerTopicListResponse,
  ListWorkspacesResponse,
  CopyWorkspaceFileEntryRequest,
  MoveWorkspaceFileEntryRequest,
  RenameWorkspaceFileEntryRequest,
  PreflightUploadWorkspaceFilesResponse,
  PutDesktopPreferencesRequest,
  ImportWorkspaceAppRequest,
  ReplaceWorkspaceAppIconRequest,
  ResizeWorkspaceTerminalRequest,
  SendWorkspaceAgentSessionInputRequest,
  SubmitWorkspaceAgentInteractiveRequest,
  TrackEvent,
  TrackEventsRequest,
  UpdateWorkspaceAgentSessionPinRequest,
  UpdateIssueManagerIssueRequest,
  UpdateIssueManagerTaskRequest,
  UpdateIssueManagerTopicRequest,
  UploadWorkspaceFilesResponse,
  UseUserProjectRequest,
  WriteWorkspaceFileTextRequest,
  WorkbenchSnapshot,
  WorkspaceAgentSession,
  WorkspaceAgentProvider,
  WorkspaceAgentSessionAttachmentResponse,
  WorkspaceAgentSessionMessagesResponse,
  WorkspaceAgentSessionListResponse,
  WorkspaceFileDirectoryResponse,
  WorkspaceFileEntryResponse,
  WorkspaceFileFilterKind,
  WorkspaceFilePreviewResponse,
  WorkspaceFileSearchResponse,
  WorkspaceFileTreeSnapshotResponse,
  WorkspaceApp,
  WorkspaceAppFactoryJob,
  WorkspaceAppFactoryJobListResponse,
  WorkspaceAppListResponse,
  PublishWorkspaceAppFactoryJobResponse,
  RollbackWorkspaceAppRequest,
  WorkspaceSummary,
  WorkspaceTerminalCloseGuard,
  WorkspaceTerminalListResponse,
  WorkspaceTerminalSession,
  WorkspaceTerminalSnapshot,
  UserProject,
  UserProjectListResponse,
  UserProjectPathCheckResponse
} from "./generated/index.ts";

export type TuttidRequestOptions = Omit<
  RequestInit,
  "body" | "headers" | "method"
>;

export type TuttidTrackEvent = TrackEvent;
export type TuttidTrackEventsRequest = TrackEventsRequest;

export interface TuttidClient {
  listCliCapabilities(workspaceID?: string): Promise<CliCapabilitiesResponse>;
  addWorkspaceIssueContextRefs(
    workspaceID: string,
    issueID: string,
    request: AddIssueManagerContextRefsRequest
  ): Promise<IssueManagerContextRefsResponse>;
  addWorkspaceIssueTaskContextRefs(
    workspaceID: string,
    issueID: string,
    taskID: string,
    request: AddIssueManagerContextRefsRequest
  ): Promise<IssueManagerContextRefsResponse>;
  completeWorkspaceIssueTaskRun(
    workspaceID: string,
    issueID: string,
    taskID: string,
    runID: string,
    request: CompleteIssueManagerRunRequest
  ): Promise<IssueManagerRunEnvelope>;
  completeWorkspaceIssueRun(
    workspaceID: string,
    issueID: string,
    runID: string,
    request: CompleteIssueManagerRunRequest
  ): Promise<IssueManagerRunEnvelope>;
  createWorkspaceIssue(
    workspaceID: string,
    request: CreateIssueManagerIssueRequest
  ): Promise<IssueManagerIssue>;
  createWorkspaceIssueTopic(
    workspaceID: string,
    request: CreateIssueManagerTopicRequest
  ): Promise<IssueManagerTopic>;
  createWorkspaceIssueTask(
    workspaceID: string,
    issueID: string,
    request: CreateIssueManagerTaskRequest
  ): Promise<IssueManagerTask>;
  createWorkspaceIssueTaskRun(
    workspaceID: string,
    issueID: string,
    taskID: string,
    request: CreateIssueManagerRunRequest
  ): Promise<IssueManagerRun>;
  createWorkspaceIssueRun(
    workspaceID: string,
    issueID: string,
    request: CreateIssueManagerRunRequest
  ): Promise<IssueManagerRun>;
  createWorkspaceFile(
    workspaceID: string,
    path: string
  ): Promise<WorkspaceFileEntryResponse>;
  readWorkspaceFilePreview(
    workspaceID: string,
    path: string
  ): Promise<WorkspaceFilePreviewResponse>;
  writeWorkspaceFileText(
    workspaceID: string,
    request: WriteWorkspaceFileTextRequest
  ): Promise<WorkspaceFileEntryResponse>;
  createWorkspaceFileDirectory(
    workspaceID: string,
    path: string
  ): Promise<WorkspaceFileEntryResponse>;
  createWorkspace(request: { name: string }): Promise<WorkspaceSummary>;
  createWorkspaceAgentSession(
    workspaceID: string,
    request: CreateWorkspaceAgentSessionRequest
  ): Promise<WorkspaceAgentSession>;
  createWorkspaceTerminal(
    workspaceID: string,
    request?: CreateWorkspaceTerminalRequest
  ): Promise<WorkspaceTerminalSession>;
  deleteWorkspaceIssue(
    workspaceID: string,
    issueID: string
  ): Promise<DeleteIssueManagerIssueResponse>;
  deleteWorkspaceIssueTask(
    workspaceID: string,
    issueID: string,
    taskID: string
  ): Promise<DeleteIssueManagerTaskResponse>;
  deleteWorkspaceIssueTopic(
    workspaceID: string,
    topicID: string
  ): Promise<DeleteIssueManagerTopicResponse>;
  deleteWorkspace(workspaceID: string): Promise<DeleteWorkspaceResponse>;
  deleteWorkspaceFileEntry(
    workspaceID: string,
    request: { kind?: WorkspaceFileFilterKind | null; path: string }
  ): Promise<DeleteWorkspaceFileEntryResponse>;
  deleteWorkspaceAgentSession(
    workspaceID: string,
    agentSessionID: string
  ): Promise<DeleteWorkspaceAgentSessionResponse>;
  moveWorkspaceFileEntry(
    workspaceID: string,
    request: MoveWorkspaceFileEntryRequest
  ): Promise<WorkspaceFileEntryResponse>;
  renameWorkspaceFileEntry(
    workspaceID: string,
    request: RenameWorkspaceFileEntryRequest
  ): Promise<WorkspaceFileEntryResponse>;
  copyWorkspaceFileEntry(
    workspaceID: string,
    request: CopyWorkspaceFileEntryRequest
  ): Promise<WorkspaceFileEntryResponse>;
  getDesktopPreferences(): Promise<DesktopPreferencesStateResponse>;
  getHealth(): Promise<HealthStatusResponse>;
  getStartupWorkspace(): Promise<WorkspaceSummary | null>;
  getWorkspace(workspaceID: string): Promise<WorkspaceSummary>;
  getWorkspaceAgentSession(
    workspaceID: string,
    agentSessionID: string
  ): Promise<WorkspaceAgentSession>;
  getAgentProviderComposerOptions(
    provider: WorkspaceAgentProvider,
    request?: GetAgentProviderComposerOptionsRequest
  ): Promise<AgentProviderComposerOptionsResponse>;
  getAgentProviderStatuses(request?: {
    providers?: WorkspaceAgentProvider[];
  }): Promise<AgentProviderStatusListResponse>;
  probeAgentProvider(
    provider: WorkspaceAgentProvider
  ): Promise<AgentProviderProbeResponse>;
  runAgentProviderAction(
    provider: WorkspaceAgentProvider,
    actionID: AgentProviderActionId
  ): Promise<AgentProviderActionRunResponse>;
  getWorkspaceIssueDetail(
    workspaceID: string,
    issueID: string
  ): Promise<IssueManagerIssueDetailResponse>;
  getWorkspaceIssueTaskDetail(
    workspaceID: string,
    issueID: string,
    taskID: string
  ): Promise<IssueManagerTaskDetailResponse>;
  getWorkspaceIssueTaskRun(
    workspaceID: string,
    issueID: string,
    taskID: string,
    runID: string
  ): Promise<IssueManagerRunEnvelope>;
  getWorkspaceIssueRun(
    workspaceID: string,
    issueID: string,
    runID: string
  ): Promise<IssueManagerRunEnvelope>;
  getWorkspaceTerminal(
    workspaceID: string,
    terminalID: string
  ): Promise<WorkspaceTerminalSession>;
  getWorkspaceTerminalSnapshot(
    workspaceID: string,
    terminalID: string
  ): Promise<WorkspaceTerminalSnapshot>;
  getWorkspaceWorkbench(workspaceID: string): Promise<WorkbenchSnapshot>;
  listWorkspaceApps(workspaceID: string): Promise<WorkspaceAppListResponse>;
  refreshWorkspaceAppCatalog(
    workspaceID: string
  ): Promise<WorkspaceAppListResponse>;
  installWorkspaceApp(
    workspaceID: string,
    appID: string
  ): Promise<WorkspaceApp>;
  exportWorkspaceApp(
    workspaceID: string,
    appID: string,
    request: ExportWorkspaceAppRequest
  ): Promise<ExportWorkspaceAppResponse>;
  importWorkspaceApp(
    workspaceID: string,
    request: ImportWorkspaceAppRequest
  ): Promise<WorkspaceApp>;
  uninstallWorkspaceApp(
    workspaceID: string,
    appID: string
  ): Promise<WorkspaceApp>;
  deleteWorkspaceApp(
    workspaceID: string,
    appID: string
  ): Promise<DeleteWorkspaceAppResponse>;
  retryWorkspaceApp(workspaceID: string, appID: string): Promise<WorkspaceApp>;
  rollbackWorkspaceApp(
    workspaceID: string,
    appID: string,
    request: RollbackWorkspaceAppRequest
  ): Promise<WorkspaceApp>;
  replaceWorkspaceAppIcon(
    workspaceID: string,
    appID: string,
    request: ReplaceWorkspaceAppIconRequest
  ): Promise<WorkspaceApp>;
  listWorkspaceAppFactoryJobs(
    workspaceID: string
  ): Promise<WorkspaceAppFactoryJobListResponse>;
  createWorkspaceAppFactoryJob(
    workspaceID: string,
    request: CreateWorkspaceAppFactoryJobRequest
  ): Promise<WorkspaceAppFactoryJob>;
  getWorkspaceAppFactoryJob(
    workspaceID: string,
    jobID: string
  ): Promise<WorkspaceAppFactoryJob>;
  deleteWorkspaceAppFactoryJob(
    workspaceID: string,
    jobID: string
  ): Promise<WorkspaceAppFactoryJobListResponse>;
  cancelWorkspaceAppFactoryJob(
    workspaceID: string,
    jobID: string
  ): Promise<WorkspaceAppFactoryJob>;
  retryWorkspaceAppFactoryJobValidation(
    workspaceID: string,
    jobID: string
  ): Promise<WorkspaceAppFactoryJob>;
  fixWorkspaceAppFactoryJob(
    workspaceID: string,
    jobID: string,
    request: FixWorkspaceAppFactoryJobRequest
  ): Promise<WorkspaceAppFactoryJob>;
  prepareWorkspaceAppFactoryJobModification(
    workspaceID: string,
    jobID: string
  ): Promise<WorkspaceAppFactoryJob>;
  publishWorkspaceAppFactoryJob(
    workspaceID: string,
    jobID: string
  ): Promise<PublishWorkspaceAppFactoryJobResponse>;
  startEnabledWorkspaceApps(
    workspaceID: string
  ): Promise<WorkspaceAppListResponse>;
  stopAllWorkspaceApps(workspaceID: string): Promise<WorkspaceAppListResponse>;
  listWorkspaceIssues(
    workspaceID: string,
    request: {
      pageSize?: number;
      pageToken?: string;
      searchQuery?: string;
      statusFilter?: IssueManagerStatus | "all";
      topicId: string;
    }
  ): Promise<IssueManagerIssueListResponse>;
  listWorkspaceIssueTopics(
    workspaceID: string
  ): Promise<IssueManagerTopicListResponse>;
  listWorkspaceIssueTaskRuns(
    workspaceID: string,
    issueID: string,
    taskID: string
  ): Promise<IssueManagerRunListResponse>;
  listWorkspaceIssueRuns(
    workspaceID: string,
    issueID: string
  ): Promise<IssueManagerRunListResponse>;
  listWorkspaceIssueTasks(
    workspaceID: string,
    issueID: string,
    request?: {
      pageSize?: number;
      pageToken?: string;
      searchQuery?: string;
      statusFilter?: IssueManagerStatus | "all";
    }
  ): Promise<IssueManagerTaskListResponse>;
  listWorkspaceTerminals(
    workspaceID: string
  ): Promise<WorkspaceTerminalListResponse>;
  listWorkspaceAgentSessions(
    workspaceID: string,
    request?: {
      limit?: number;
      searchQuery?: string;
      visibleOnly?: boolean;
    }
  ): Promise<WorkspaceAgentSessionListResponse>;
  listWorkspaceAgentSessionMessages(
    workspaceID: string,
    agentSessionID: string,
    request?: {
      afterVersion?: number;
      beforeVersion?: number;
      order?: "asc" | "desc";
      limit?: number;
    }
  ): Promise<WorkspaceAgentSessionMessagesResponse>;
  listWorkspaceFileDirectory(
    workspaceID: string,
    request?: {
      includeHidden?: boolean;
      path?: string;
    }
  ): Promise<WorkspaceFileDirectoryResponse>;
  getWorkspaceFileTreeSnapshot(
    workspaceID: string,
    request?: {
      includeHidden?: boolean;
      path?: string;
      prefetchBudgetMs?: number;
      prefetchDepth?: number;
    }
  ): Promise<WorkspaceFileTreeSnapshotResponse>;
  listWorkspaces(): Promise<ListWorkspacesResponse>;
  checkUserProjectPath(
    request: CheckUserProjectPathRequest
  ): Promise<UserProjectPathCheckResponse>;
  listUserProjects(): Promise<UserProjectListResponse>;
  openWorkspace(workspaceID: string): Promise<WorkspaceSummary>;
  removeWorkspaceIssueContextRef(
    workspaceID: string,
    issueID: string,
    contextRefID: string
  ): Promise<DeleteIssueManagerContextRefResponse>;
  removeWorkspaceIssueTaskContextRef(
    workspaceID: string,
    issueID: string,
    taskID: string,
    contextRefID: string
  ): Promise<DeleteIssueManagerContextRefResponse>;
  updateWorkspace(
    workspaceID: string,
    request: {
      name: string;
    }
  ): Promise<WorkspaceSummary>;
  updateWorkspaceIssue(
    workspaceID: string,
    issueID: string,
    request: UpdateIssueManagerIssueRequest
  ): Promise<IssueManagerIssue>;
  updateWorkspaceIssueTopic(
    workspaceID: string,
    topicID: string,
    request: UpdateIssueManagerTopicRequest
  ): Promise<IssueManagerTopic>;
  updateWorkspaceIssueTask(
    workspaceID: string,
    issueID: string,
    taskID: string,
    request: UpdateIssueManagerTaskRequest
  ): Promise<IssueManagerTask>;
  putWorkspaceWorkbench(
    workspaceID: string,
    snapshot: WorkbenchSnapshot
  ): Promise<WorkbenchSnapshot>;
  checkWorkspaceTerminalCloseGuard(
    workspaceID: string,
    terminalID: string
  ): Promise<WorkspaceTerminalCloseGuard>;
  resizeWorkspaceTerminal(
    workspaceID: string,
    terminalID: string,
    request: ResizeWorkspaceTerminalRequest
  ): Promise<WorkspaceTerminalSession>;
  cancelWorkspaceAgentSession(
    workspaceID: string,
    agentSessionID: string
  ): Promise<WorkspaceAgentSession>;
  cancelWorkspaceAgentSessionWithResult(
    workspaceID: string,
    agentSessionID: string
  ): Promise<CancelWorkspaceAgentSessionResponse>;
  sendWorkspaceAgentSessionInput(
    workspaceID: string,
    agentSessionID: string,
    request: SendWorkspaceAgentSessionInputRequest
  ): Promise<WorkspaceAgentSession>;
  readWorkspaceAgentSessionAttachment(
    workspaceID: string,
    agentSessionID: string,
    attachmentID: string
  ): Promise<WorkspaceAgentSessionAttachmentResponse>;
  updateWorkspaceAgentSessionSettings(
    workspaceID: string,
    agentSessionID: string,
    request: AgentSessionComposerSettings
  ): Promise<WorkspaceAgentSession>;
  updateWorkspaceAgentSessionPin(
    workspaceID: string,
    agentSessionID: string,
    request: UpdateWorkspaceAgentSessionPinRequest
  ): Promise<WorkspaceAgentSession>;
  submitWorkspaceAgentInteractive(
    workspaceID: string,
    agentSessionID: string,
    requestID: string,
    request: SubmitWorkspaceAgentInteractiveRequest
  ): Promise<WorkspaceAgentSession>;
  searchWorkspaceFiles(
    workspaceID: string,
    request: {
      includeHidden?: boolean;
      includeKinds?: WorkspaceFileFilterKind[];
      limit?: number;
      query: string;
    },
    requestOptions?: TuttidRequestOptions
  ): Promise<WorkspaceFileSearchResponse>;
  preflightUploadWorkspaceFiles(
    workspaceID: string,
    request: {
      sourcePaths: string[];
      targetDirectoryPath: string;
    }
  ): Promise<PreflightUploadWorkspaceFilesResponse>;
  putDesktopPreferences(
    request: PutDesktopPreferencesRequest
  ): Promise<DesktopPreferencesStateResponse>;
  trackEvents(events: TuttidTrackEvent[]): Promise<void>;
  deleteUserProject(request: DeleteUserProjectRequest): Promise<void>;
  useUserProject(request: UseUserProjectRequest): Promise<UserProject>;
  uploadWorkspaceFiles(
    workspaceID: string,
    request: {
      overwrite?: boolean;
      sourcePaths: string[];
      targetDirectoryPath: string;
    }
  ): Promise<UploadWorkspaceFilesResponse>;
  terminateWorkspaceTerminal(
    workspaceID: string,
    terminalID: string
  ): Promise<WorkspaceTerminalSession>;
}

export interface CreateTuttidClientInput {
  auth?: string;
  baseUrl?: string;
  fetch: typeof fetch;
}
