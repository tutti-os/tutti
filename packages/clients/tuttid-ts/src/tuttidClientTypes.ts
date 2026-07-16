import type {
  AddIssueManagerContextRefsRequest,
  AccountLoginStartResponse,
  AccountLoginStatusResponse,
  AccountProductSummaryResponse,
  AccountUserInfo,
  AgentProviderComposerOptionsResponse,
  AgentProviderProbeResponse,
  AgentProviderActionId,
  AgentProviderActionRunResponse,
  AppReferenceListRequest,
  AppReferenceListResponse,
  AppReferenceSearchRequest,
  AppReferenceSearchResponse,
  AgentProviderStatusListResponse,
  WorkspaceAgentTurnCancelResponse,
  ClearWorkspaceAgentSessionsResponse,
  GoalControlWorkspaceAgentSessionResponse,
  GetWorkspaceAgentSessionGoalResponse,
  ReconcileWorkspaceAgentSessionGoalResponse,
  WorkspaceAgentSessionGoalControlRequest,
  CliCapabilitiesResponse,
  AgentSessionComposerSettings,
  GetAgentProviderComposerOptionsRequest,
  GetWorkspaceAppFactoryAgentTargetComposerOptionsRequest,
  CompleteIssueManagerRunRequest,
  CheckUserProjectPathRequest,
  CreateIssueManagerIssueRequest,
  CreateIssueManagerRunRequest,
  CreateIssueManagerTaskRequest,
  CreateIssueManagerTasksRequest,
  CreateIssueManagerTopicRequest,
  CreateWorkspaceAgentSessionRequest,
  CreateWorkspaceAppFactoryJobRequest,
  CreateWorkspaceTerminalRequest,
  DeleteWorkspaceAgentSessionResponse,
  DeleteWorkspaceAgentSessionsBatchRequest,
  DeleteWorkspaceAgentSessionsBatchResponse,
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
  ExternalAgentImportResultResponse,
  ExternalAgentImportScanRequest,
  ExternalAgentImportScanResponse,
  FixWorkspaceAppFactoryJobRequest,
  HealthStatusResponse,
  InstallWorkspaceAppRequest,
  ImportExternalAgentSessionsRequest,
  LoadLocalWorkspaceAppRequest,
  IssueManagerContextRefsResponse,
  IssueManagerIssue,
  IssueManagerIssueDetailResponse,
  IssueManagerIssueListResponse,
  IssueManagerReferenceSearchRequest,
  IssueManagerReferenceSearchResponse,
  IssueManagerRun,
  IssueManagerRunEnvelope,
  IssueManagerRunListResponse,
  IssueManagerStatus,
  IssueManagerTask,
  IssueManagerTaskDetailResponse,
  IssueManagerTaskListResponse,
  IssueManagerTopic,
  IssueManagerTopicListResponse,
  ListAgentTargetsResponse,
  AgentTarget,
  ListWorkspacesResponse,
  CopyWorkspaceFileEntryRequest,
  MoveWorkspaceFileEntryRequest,
  RenameWorkspaceFileEntryRequest,
  PrepareWorkspaceAppUploadRequest,
  PrepareWorkspaceAppUploadResponse,
  PreflightUploadWorkspaceFilesResponse,
  PutDesktopPreferencesRequest,
  ImportWorkspaceAppRequest,
  ReplaceWorkspaceAppIconRequest,
  ReloadLocalWorkspaceAppRequest,
  ResizeWorkspaceTerminalRequest,
  SendWorkspaceAgentSessionInputResponse,
  SubmitWorkspaceAgentPlanDecisionRequest,
  SendWorkspaceAgentSessionInputRequest,
  SubmitWorkspaceAgentInteractiveRequest,
  TrackEvent,
  TrackEventsRequest,
  UpdateWorkspaceAgentSessionPinRequest,
  UpdateWorkspaceAgentSessionTitleRequest,
  UpdateWorkspaceAgentSessionVisibilityRequest,
  WorkspaceGitPatchRequest,
  WorkspaceGitPatchResponse,
  UpdateIssueManagerIssueRequest,
  UpdateIssueManagerTaskRequest,
  UpdateIssueManagerTopicRequest,
  UploadWorkspaceFilesResponse,
  UseUserProjectRequest,
  WriteWorkspaceFileTextRequest,
  WorkbenchSnapshot,
  WorkspaceAgentSession,
  WorkspaceAgentSessionDetailResponse,
  WorkspaceAgentPlanDecisionResponse,
  WorkspaceAgentProvider,
  WorkspaceAgentSessionAttachmentResponse,
  WorkspaceAgentGeneratedFileListResponse,
  WorkspaceAgentSessionGitBranchesResponse,
  WorkspaceGitPatchSupportResponse,
  WorkspaceAgentSessionPageResponse,
  WorkspaceAgentSessionSectionDeletionCandidatesResponse,
  WorkspaceAgentSessionSectionPageResponse,
  WorkspaceAgentSessionSectionsResponse,
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
  WorkspaceAppMentionCandidatesResponse,
  WorkspaceAppUploadedFile,
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
  listAgentTargets(): Promise<ListAgentTargetsResponse>;
  setSystemAgentTargetEnabled(
    agentTargetID: string,
    enabled: boolean
  ): Promise<AgentTarget>;
  startAccountLogin(): Promise<AccountLoginStartResponse>;
  getAccountLoginStatus(attemptID: string): Promise<AccountLoginStatusResponse>;
  getAccountUserInfo(): Promise<AccountUserInfo | null>;
  getAccountProductSummary(): Promise<AccountProductSummaryResponse>;
  dismissAccountRegistrationCreditsReward(rewardID: string): Promise<void>;
  logoutAccount(): Promise<void>;
  listCliCapabilities(
    workspaceID?: string,
    options?: { includeHidden?: boolean; includeIntegration?: boolean }
  ): Promise<CliCapabilitiesResponse>;
  listWorkspaceAppMentionCandidates(
    workspaceID: string
  ): Promise<WorkspaceAppMentionCandidatesResponse>;
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
  createWorkspaceIssueTasks(
    workspaceID: string,
    issueID: string,
    request: CreateIssueManagerTasksRequest
  ): Promise<IssueManagerTask[]>;
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
    request: CreateWorkspaceAgentSessionRequest,
    requestOptions?: TuttidRequestOptions
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
  deleteWorkspaceAgentSessionsBatch(
    workspaceID: string,
    request: DeleteWorkspaceAgentSessionsBatchRequest,
    requestOptions?: TuttidRequestOptions
  ): Promise<DeleteWorkspaceAgentSessionsBatchResponse>;
  clearWorkspaceAgentSessions(
    workspaceID: string
  ): Promise<ClearWorkspaceAgentSessionsResponse>;
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
  ): Promise<WorkspaceAgentSessionDetailResponse>;
  getAgentProviderComposerOptions(
    provider: WorkspaceAgentProvider,
    request?: GetAgentProviderComposerOptionsRequest,
    requestOptions?: TuttidRequestOptions
  ): Promise<AgentProviderComposerOptionsResponse>;
  getAgentProviderStatuses(request?: {
    providers?: WorkspaceAgentProvider[];
    /**
     * Opt into the network connectivity probe. Off by default so the dock /
     * startup detection stays local and never blocks on the network; only the
     * agent-env wizard's network diagnostic sets this.
     */
    includeNetwork?: boolean;
    /** Bypass the daemon provider-readiness cache. */
    refresh?: boolean;
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
  searchWorkspaceIssueReferences(
    workspaceID: string,
    request: IssueManagerReferenceSearchRequest
  ): Promise<IssueManagerReferenceSearchResponse>;
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
  listWorkspaceAppReferences(
    workspaceID: string,
    appID: string,
    request: AppReferenceListRequest
  ): Promise<AppReferenceListResponse>;
  searchWorkspaceAppReferences(
    workspaceID: string,
    appID: string,
    request: AppReferenceSearchRequest
  ): Promise<AppReferenceSearchResponse>;
  prepareWorkspaceAppUpload(
    workspaceID: string,
    appID: string,
    request: PrepareWorkspaceAppUploadRequest
  ): Promise<PrepareWorkspaceAppUploadResponse>;
  completeWorkspaceAppUpload(
    workspaceID: string,
    appID: string,
    uploadID: string
  ): Promise<WorkspaceAppUploadedFile>;
  cancelWorkspaceAppUpload(
    workspaceID: string,
    appID: string,
    uploadID: string
  ): Promise<void>;
  refreshWorkspaceAppCatalog(
    workspaceID: string
  ): Promise<WorkspaceAppListResponse>;
  installWorkspaceApp(
    workspaceID: string,
    appID: string,
    request?: InstallWorkspaceAppRequest
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
  loadLocalWorkspaceApp(
    workspaceID: string,
    request: LoadLocalWorkspaceAppRequest
  ): Promise<WorkspaceApp>;
  uninstallWorkspaceApp(
    workspaceID: string,
    appID: string
  ): Promise<WorkspaceApp>;
  deleteWorkspaceApp(
    workspaceID: string,
    appID: string
  ): Promise<DeleteWorkspaceAppResponse>;
  launchWorkspaceApp(workspaceID: string, appID: string): Promise<WorkspaceApp>;
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
  reloadLocalWorkspaceApp(
    workspaceID: string,
    appID: string,
    request?: ReloadLocalWorkspaceAppRequest
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
  getWorkspaceAppFactoryAgentTargetComposerOptions(
    workspaceID: string,
    agentTargetID: string,
    request?: GetWorkspaceAppFactoryAgentTargetComposerOptionsRequest
  ): Promise<AgentProviderComposerOptionsResponse>;
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
    },
    requestOptions?: TuttidRequestOptions
  ): Promise<IssueManagerIssueListResponse>;
  listWorkspaceIssueTopics(
    workspaceID: string,
    requestOptions?: TuttidRequestOptions
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
      agentTargetId?: string;
      cursor?: string;
      limit?: number;
      searchQuery?: string;
    },
    requestOptions?: TuttidRequestOptions
  ): Promise<WorkspaceAgentSessionListResponse>;
  listWorkspaceAgentSessionSections(
    workspaceID: string,
    request?: {
      agentTargetId?: string;
      limitPerSection?: number;
    },
    requestOptions?: TuttidRequestOptions
  ): Promise<WorkspaceAgentSessionSectionsResponse>;
  listWorkspaceAgentSessionSectionPage(
    workspaceID: string,
    request: {
      sectionKey: string;
      agentTargetId?: string;
      cursor?: string;
      limit?: number;
    },
    requestOptions?: TuttidRequestOptions
  ): Promise<WorkspaceAgentSessionSectionPageResponse>;
  listWorkspaceAgentSessionSectionDeletionCandidates(
    workspaceID: string,
    request: {
      sectionKey: string;
      agentTargetId?: string;
      excludePinned?: boolean;
    },
    requestOptions?: TuttidRequestOptions
  ): Promise<WorkspaceAgentSessionSectionDeletionCandidatesResponse>;
  listWorkspaceAgentPinnedSessionPage(
    workspaceID: string,
    request?: {
      agentTargetId?: string;
      cursor?: string;
      limit?: number;
    },
    requestOptions?: TuttidRequestOptions
  ): Promise<WorkspaceAgentSessionPageResponse>;
  listWorkspaceAgentGeneratedFiles(
    workspaceID: string,
    request: {
      agentTargetIds?: string[];
      cursor?: string;
      limit?: number;
      query?: string;
      sectionKey: string;
    },
    requestOptions?: TuttidRequestOptions
  ): Promise<WorkspaceAgentGeneratedFileListResponse>;
  scanWorkspaceExternalAgentSessionImports(
    workspaceID: string,
    request?: ExternalAgentImportScanRequest
  ): Promise<ExternalAgentImportScanResponse>;
  importWorkspaceExternalAgentSessions(
    workspaceID: string,
    request: ImportExternalAgentSessionsRequest
  ): Promise<ExternalAgentImportResultResponse>;
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
  listWorkspaceRecentFiles(
    workspaceID: string,
    request?: {
      limit?: number;
    },
    requestOptions?: TuttidRequestOptions
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
  cancelWorkspaceAgentTurn(
    workspaceID: string,
    agentSessionID: string,
    turnID: string
  ): Promise<WorkspaceAgentTurnCancelResponse>;
  goalControlWorkspaceAgentSession(
    workspaceID: string,
    agentSessionID: string,
    request: WorkspaceAgentSessionGoalControlRequest
  ): Promise<GoalControlWorkspaceAgentSessionResponse>;
  getWorkspaceAgentSessionGoal(
    workspaceID: string,
    agentSessionID: string
  ): Promise<GetWorkspaceAgentSessionGoalResponse>;
  reconcileWorkspaceAgentSessionGoal(
    workspaceID: string,
    agentSessionID: string
  ): Promise<ReconcileWorkspaceAgentSessionGoalResponse>;
  sendWorkspaceAgentSessionInput(
    workspaceID: string,
    agentSessionID: string,
    request: SendWorkspaceAgentSessionInputRequest
  ): Promise<SendWorkspaceAgentSessionInputResponse>;
  submitWorkspaceAgentPlanDecision(
    workspaceID: string,
    agentSessionID: string,
    turnID: string,
    requestID: string,
    request: SubmitWorkspaceAgentPlanDecisionRequest
  ): Promise<WorkspaceAgentPlanDecisionResponse>;
  readWorkspaceAgentSessionAttachment(
    workspaceID: string,
    agentSessionID: string,
    attachmentID: string
  ): Promise<WorkspaceAgentSessionAttachmentResponse>;
  listWorkspaceAgentSessionGitBranches(
    workspaceID: string,
    agentSessionID: string
  ): Promise<WorkspaceAgentSessionGitBranchesResponse>;
  listWorkspaceGitBranches(
    workspaceID: string,
    workingDirectory: string
  ): Promise<WorkspaceAgentSessionGitBranchesResponse>;
  resolveWorkspaceGitPatchSupport(
    workspaceID: string,
    cwd: string
  ): Promise<WorkspaceGitPatchSupportResponse>;
  applyWorkspaceGitPatch(
    workspaceID: string,
    request: WorkspaceGitPatchRequest
  ): Promise<WorkspaceGitPatchResponse>;
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
  updateWorkspaceAgentSessionTitle(
    workspaceID: string,
    agentSessionID: string,
    request: UpdateWorkspaceAgentSessionTitleRequest
  ): Promise<WorkspaceAgentSession>;
  updateWorkspaceAgentSessionVisibility(
    workspaceID: string,
    agentSessionID: string,
    request: UpdateWorkspaceAgentSessionVisibilityRequest
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
      /** 已选文件类型筛选分类 id(全局统一口径);query 可空、filters 非空时即「仅按类型查」。 */
      filters?: string[];
      /** 把搜索限定在工作区根下某子路径(左栏选中的「位置」);缺省/空 = 跨整根搜索。 */
      within?: string;
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
