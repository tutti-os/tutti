export interface AgentHostMockSession {
  name: string;
  userId: string;
  email?: string;
  avatar?: string;
}

export const UNAUTHENTICATED_AGENT_HOST_MOCK_SESSION: AgentHostMockSession = {
  name: "Guest",
  userId: "guest"
};

export function createUnauthenticatedAgentHostMockSession(): AgentHostMockSession {
  return { ...UNAUTHENTICATED_AGENT_HOST_MOCK_SESSION };
}

export function isUnauthenticatedAgentHostMockSession(
  session: AgentHostMockSession | null | undefined
): boolean {
  const userId = session?.userId?.trim() ?? "";
  if (!userId) {
    return true;
  }

  return userId === UNAUTHENTICATED_AGENT_HOST_MOCK_SESSION.userId;
}

export interface AgentHostRoomSummary {
  id: string;
  name: string;
  ownerUserId: string;
  memberUserIds?: string[];
  createdAtUnix?: string;
  updatedAtUnix?: string;
  role?: AgentHostRoomRole;
  relationship?: AgentHostRoomRelationship;
  templateId?: string;
  templateManifestUrl?: string;
  templateInitialFileTreeRefreshDepth?: number;
  statusSnapshot?: AgentHostRoomStatus;
}

export type AgentHostRoomRole = "owner" | "collaborator";
export type AgentHostRoomRelationship = "all" | "owned" | "shared";

export interface AgentHostLastCompletedAgentTask {
  agentSessionId: string;
  provider?: string;
  title: string;
  completedAtUnixMs: string;
  actorUserId?: string;
}

/** 单条 turn 预览（与用户消息 / agent 回复一一对应，可带独立 provider 或 session） */
export interface AgentHostLatestTurnPreviewLine {
  role: "user" | "agent";
  text: string;
  actorUserId?: string;
  provider?: string;
  agentSessionId?: string;
}

export interface AgentHostLatestTurnPreview {
  userMessage?: string;
  actorUserId?: string;
  agentAction?: string;
  agentActionKind?: string;
  provider?: string;
  agentSessionId?: string;
  turnId?: string;
  updatedAtUnixMs?: string;
  /** 存在时优先于 userMessage + agentAction，用于多条、多 agent 来源的预览 */
  lines?: AgentHostLatestTurnPreviewLine[];
}

export interface AgentHostLatestActiveAgentSession {
  agentSessionId?: string;
  provider?: string;
  status?: string;
  updatedAtUnixMs?: string;
}

export interface AgentHostWorkspaceAgentProviderUsage {
  provider: string;
  sessionCount: number;
  lastWorkedAtUnixMs?: string;
}

export interface AgentHostRoomStatus {
  roomId: string;
  memberCount: number;
  memberUserIds?: string[];
  activeMemberCount?: number;
  activeAgentSessionCount?: number;
  workedAgentProviders?: AgentHostWorkspaceAgentProviderUsage[];
  lastCompletedAgentTask?: AgentHostLastCompletedAgentTask;
  latestTurnPreview?: AgentHostLatestTurnPreview;
  latestActiveAgentSession?: AgentHostLatestActiveAgentSession;
  userSnapshot?: AgentHostRoomUserSnapshot;
  refreshedAtUnixMs: string;
}

export interface AgentHostRoomUserSnapshot {
  imageUrl: string;
  capturedAtUnixMs: string;
}

export interface AgentHostCreateObjectUploadResult {
  uploadId: string;
  objectKey?: string;
  uploadUrl: string;
  headers?: Record<string, string>;
  expiresAt?: string;
}

export interface AgentHostCompleteObjectUploadResult {
  uploadId: string;
  objectKey?: string;
  status: string;
}

export interface AgentHostSetRoomUserSnapshotResult {
  roomId: string;
  capturedAtUnixMs: number;
}

export interface AgentHostCaptureRoomSnapshotInput {
  roomId?: string | null;
}

export interface AgentHostLeaveRoomMembershipInput {
  roomId?: string | null;
}

export interface AgentHostCaptureRoomSnapshotResult {
  captured: boolean;
  imageUrl?: string;
  capturedAtUnixMs?: number;
}

export interface AgentHostListRoomsInput {
  relationship?: AgentHostRoomRelationship;
  pageSize?: number;
  pageToken?: string;
}

export interface AgentHostListRoomsResult {
  rooms: AgentHostRoomSummary[];
  nextPageToken?: string;
  totalCount?: number;
}

export interface AgentHostBetaAccess {
  userId: string;
  appId: string;
  status: string;
  grantedAt?: string;
}

export interface AgentHostCheckBetaAccessResult {
  inBeta: boolean;
  betaAccess?: AgentHostBetaAccess | null;
}

export interface AgentHostBetaInviteCode {
  id: string;
  code: string;
  status: string;
  usedBy?: string;
  appId?: string;
}

export interface AgentHostConsumeBetaInviteCodeInput {
  code: string;
}

export interface AgentHostConsumeBetaInviteCodeResult {
  success: boolean;
  message?: string;
  inviteCode?: AgentHostBetaInviteCode | null;
}

export interface AgentHostRoomStatusBatchInput {
  roomIds: string[];
}

export interface AgentHostRoomStatusBatchResult {
  statuses: Record<string, AgentHostRoomStatus>;
}

export interface AgentHostDeleteRoomResult {
  roomId: string;
}

export interface AgentHostRoomKey {
  userId: string;
  roomId: string;
}

export interface AgentHostCapabilitiesResult {
  desktopMode: boolean;
  mockAuth: boolean;
  roomListMode: string;
  platforms: string[];
  /** Short hostname from desktopd for device-centric copy (e.g. Manage Agents). */
  hostDisplayName?: string;
}

export interface AgentHostManagedAgentsStateItem {
  toolId: string;
  toolClass: string;
  agentId?: string;
  hostDetected?: boolean;
  hostConfigDetected?: boolean;
  hostVersion?: string;
  targetVersion: string;
  recommendedVersion?: string;
  decisionReason: string;
  fallbackApplied: boolean;
  notes?: string;
}

export interface AgentHostToolchainConfigSyncedAgent {
  agentId: string;
  /** RFC3339 timestamp for when Tutti last synced this agent's host config. */
  syncedAt?: string;
}

export interface AgentHostManagedAgentsState {
  metadataSynced: boolean;
  toolCatalogRevision: string;
  agentProfileRevision: string;
  totalCount: number;
  items: AgentHostManagedAgentsStateItem[];
  /** Agent IDs ready for normal AgentGUI use (installed and authenticated/ready). */
  readyAgentIds: string[];
  /** Agent IDs whose host config has been synced to the VM through Manage Agents. */
  configSyncedAgentIds: string[];
  /** Agent config sync metadata, including when Tutti last copied host config. */
  configSyncedAgents?: AgentHostToolchainConfigSyncedAgent[];
}

export type AgentHostManageAgentActionKind = "sync" | "install" | "uninstall";

export interface AgentHostManageToolchainAgentInput {
  agentId: string;
  action: AgentHostManageAgentActionKind;
}

export interface AgentHostManageToolchainAgentResult {
  applied: boolean;
  alreadyUninstalled?: boolean;
  toolchainApply?: AgentHostToolchainApplySummary;
  /** Agent IDs ready for normal AgentGUI use after applying this action. */
  readyAgentIds?: string[];
  configSyncedAgentIds?: string[];
  configSyncedAgents?: AgentHostToolchainConfigSyncedAgent[];
}

export type AgentHostConnectorMCPTransport = "stdio" | "sse" | "http";

export interface AgentHostConnectorMCPServer {
  id: string;
  name?: string;
  description?: string;
  installStatus?: "ready" | "failed" | "skipped";
  installMessage?: string;
  transport: AgentHostConnectorMCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  agents?: string[];
  source?: "builtin" | "user";
}

export interface AgentHostConnectorMCPRegistry {
  version: 1;
  builtinServers?: string[];
  servers: AgentHostConnectorMCPServer[];
}

export interface AgentHostConnectorMCPAuthStatus {
  serverId: string;
  authenticated: boolean;
  expiresAtMs?: number;
  scope?: string;
}

export interface AgentHostConnectorMCPListResult {
  path: string;
  registry: AgentHostConnectorMCPRegistry;
  builtinServers: AgentHostConnectorMCPServer[];
  authStatuses?: Record<string, AgentHostConnectorMCPAuthStatus>;
  registryReadError?: string;
  installResults?: AgentHostConnectorMCPInstallResult[];
  /** Built-in server ids removed on save because no stored OAuth session was available (others still apply). */
  registryPrunedServerIds?: string[];
}

export interface AgentHostConnectorMCPSaveInput {
  registry: AgentHostConnectorMCPRegistry;
}

export interface AgentHostConnectorMCPInstallResult {
  serverId: string;
  status: "ready" | "failed" | "skipped";
  message?: string;
}

export interface AgentHostConnectorSkillSummary {
  name: string;
  path: string;
  content: string;
  source: "builtin" | "user";
}

export interface AgentHostConnectorSkillListResult {
  root: string;
  skills: AgentHostConnectorSkillSummary[];
}

export interface AgentHostUserInfo {
  userId: string;
  email?: string;
  avatar?: string;
  avatarObjectKey?: string;
  name?: string;
}

export interface AgentHostBatchUserInfoInput {
  userIds: string[];
}

export interface AgentHostBatchUserInfoResult {
  users: AgentHostUserInfo[];
}

export interface AgentHostUpdateUserProfileInput {
  name?: string;
  avatar?: string;
  avatarObjectKey?: string;
}

export const TSH_DESKTOP_MAX_USER_DISPLAY_NAME_LENGTH = 32;

export function normalizeAgentHostUserDisplayName(name: string): string {
  return Array.from(name.trim())
    .slice(0, TSH_DESKTOP_MAX_USER_DISPLAY_NAME_LENGTH)
    .join("");
}

export type AgentHostAccountAuthStatus = "authenticated" | "unauthenticated";

export type AgentHostAccountUserProfile = AgentHostUserInfo;

export interface AgentHostAccountSnapshot {
  authStatus: AgentHostAccountAuthStatus;
  currentUserId: string | null;
  currentUser: AgentHostAccountUserProfile | null;
  profilesByUserId: Record<string, AgentHostAccountUserProfile>;
}

export interface AgentHostEnsureAccountProfilesInput {
  userIds: string[];
}

export type AgentHostRoomVisibility = "private" | "team" | "public";
export type AgentHostRoomProvider = "e2b";

export interface AgentHostCreateRoomInput {
  name: string;
  /** Local source folder agents may use; forwarded when control plane supports it. */
  sourceDirectory?: string;
  visibility?: AgentHostRoomVisibility;
  provider?: AgentHostRoomProvider;
  templateId?: string;
  templateInitialFileTreeRefreshDepth?: number;
  /** Whether to persist the OpenClaw CLI selection before creating the workspace. */
  installOpenclaw?: boolean;
}

export interface AgentHostCreateAndEnterRoomInput {
  name: string;
  /** Local source folder agents may use; forwarded when control plane supports it. */
  sourceDirectory?: string;
  visibility?: AgentHostRoomVisibility;
  provider?: AgentHostRoomProvider;
  templateId?: string;
  templateInitialFileTreeRefreshDepth?: number;
  /** Whether to install OpenClaw CLI during the immediate enter handoff. */
  installOpenclaw?: boolean;
  /** Whether the newly opened room window should auto-open the task center. */
  openTaskCenterOnEnter?: boolean;
}

export interface AgentHostUpdateRoomInput {
  roomId: string;
  name: string;
}

export interface AgentHostWorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  manifestUrl: string;
  version: string;
  iconUrl?: string;
  heroImageUrl?: string;
}

export interface AgentHostListWorkspaceTemplatesResult {
  templates: AgentHostWorkspaceTemplate[];
}

export interface AgentHostSyncRoomTemplateBootstrapInput {
  roomId: string;
  templateBootstrap: AgentHostTemplateBootstrapResult | null;
}

export interface AgentHostGenerateRoomShareInput {
  roomId: string;
  slotIndex?: number;
  issueId?: string;
}

export interface AgentHostRoomShareResult {
  roomId: string;
  inviteId?: string;
  slotIndex?: number;
  inviteCode: string;
  issueId?: string;
  password?: string;
  status?: AgentHostRoomShareInviteStatus;
  createdAtUnix?: number;
  rotatedAtUnix: number;
  deepLink: string;
  webLink?: string;
}

export interface AgentHostJoinSharedRoomInput {
  roomId: string;
  inviteCode?: string;
  /** Renderer-only hint: open the room issue manager on this issue after the room window is shown. */
  pendingIssueId?: string | null;
}

export interface AgentHostRoomTaskDetail {
  task: AgentHostRoomTaskSummary;
  issues: AgentHostRoomIssueSummary[];
}

export interface AgentHostRoomTaskSummary {
  taskId: string;
  workspaceId?: string;
  roomId: string;
  title: string;
  content: string;
  status:
    | "not_started"
    | "running"
    | "pending_acceptance"
    | "completed"
    | "failed"
    | "canceled"
    | string;
  creatorUserId: string;
  creatorDisplayName?: string;
  creatorAvatarUrl?: string;
  issueCount: number;
  manualIssueCount?: number;
  notStartedCount: number;
  runningCount: number;
  pendingAcceptanceCount: number;
  completedCount: number;
  failedCount: number;
  canceledCount: number;
  createdAtUnix?: number;
  updatedAtUnix?: number;
}

export type AgentHostRoomTaskStatusFilter =
  | "all"
  | "not_started"
  | "running"
  | "pending_acceptance"
  | "completed"
  | "failed"
  | "canceled";

export interface AgentHostRoomTaskStatusCounts {
  all: number;
  notStarted: number;
  running: number;
  pendingAcceptance: number;
  completed: number;
  failed: number;
  canceled: number;
}

export interface AgentHostListRoomTasksInput {
  roomId: string;
  pageSize?: number;
  pageToken?: string;
  statusFilter?: AgentHostRoomTaskStatusFilter | string;
  searchQuery?: string;
}

export interface AgentHostListRoomTasksResult {
  tasks: AgentHostRoomTaskSummary[];
  nextPageToken?: string;
  totalCount?: number;
  statusCounts?: AgentHostRoomTaskStatusCounts;
}

export interface AgentHostCreateRoomTaskInput {
  roomId: string;
  taskId: string;
  title: string;
  content?: string;
}

export interface AgentHostUpdateRoomTaskInput {
  roomId: string;
  taskId: string;
  title?: string;
  content?: string;
}

export interface AgentHostDeleteRoomTaskInput {
  roomId: string;
  taskId: string;
}

export interface AgentHostGetRoomTaskInput {
  roomId: string;
  taskId: string;
}

export const TSH_DESKTOP_PRIMARY_EXECUTION_ISSUE_ID_PREFIX =
  "primary-task-execution";
export type AgentHostRoomIssueOrigin =
  | "primary_task_execution"
  | "manual"
  | string;

export interface AgentHostRoomIssueSummary {
  issueId: string;
  taskId?: string;
  roomId: string;
  title: string;
  content?: string;
  description?: string;
  sortIndex?: number;
  status:
    | "not_started"
    | "running"
    | "pending_acceptance"
    | "completed"
    | "failed"
    | "canceled"
    | string;
  priority: "high" | "medium" | "low" | string;
  dueAtUnix?: number;
  creatorUserId: string;
  creatorDisplayName?: string;
  creatorAvatarUrl?: string;
  origin?: AgentHostRoomIssueOrigin;
  latestRunId?: string;
  createdAtUnix?: number;
  updatedAtUnix?: number;
}

export type AgentHostRoomIssueStatusFilter =
  | "all"
  | "not_started"
  | "running"
  | "pending_acceptance"
  | "completed"
  | "failed"
  | "canceled";

export interface AgentHostRoomIssueStatusCounts {
  all: number;
  notStarted: number;
  running: number;
  pendingAcceptance: number;
  completed: number;
  failed: number;
  canceled: number;
}

export interface AgentHostListRoomIssuesInput {
  roomId: string;
  taskId?: string;
  pageSize?: number;
  pageToken?: string;
  statusFilter?: AgentHostRoomIssueStatusFilter | string;
  searchQuery?: string;
}

export interface AgentHostListRoomIssuesResult {
  issues: AgentHostRoomIssueSummary[];
  nextPageToken?: string;
  totalCount?: number;
  statusCounts?: AgentHostRoomIssueStatusCounts;
}

export interface AgentHostRoomIssueContextRef {
  contextRefId: string;
  issueId: string;
  taskId?: string;
  roomId: string;
  refType: "file" | "folder" | "upload" | string;
  path: string;
  displayName: string;
  createdAtUnix?: number;
}

export interface AgentHostRoomIssueRun {
  runId: string;
  issueId: string;
  taskId?: string;
  roomId: string;
  requesterUserId: string;
  agentUserId: string;
  agentSessionId?: string;
  agentProvider?: "codex" | "claude-code" | "nexight" | "gemini" | string;
  status: "running" | "completed" | "failed" | "canceled" | string;
  summary?: string;
  errorMessage?: string;
  outputDir?: string;
  createdAtUnix?: number;
  startedAtUnix?: number;
  completedAtUnix?: number;
  updatedAtUnix?: number;
}

export interface AgentHostRoomIssueRunOutput {
  outputId: string;
  runId: string;
  issueId: string;
  taskId?: string;
  roomId: string;
  path: string;
  displayName: string;
  mediaType?: string;
  sizeBytes?: number;
  createdAtUnix?: number;
}

export interface AgentHostRoomIssueShareCapability {
  canGenerateInviteLink: boolean;
  roomFull: boolean;
  remainingCollaboratorSlots: number;
  remainingActiveInviteSlots: number;
}

export interface AgentHostRoomIssueDetail {
  issue: AgentHostRoomIssueSummary;
  contextRefs: AgentHostRoomIssueContextRef[];
  latestRun?: AgentHostRoomIssueRun | null;
  recentRuns: AgentHostRoomIssueRun[];
  latestOutputs: AgentHostRoomIssueRunOutput[];
  shareCapability: AgentHostRoomIssueShareCapability;
}

export interface AgentHostCreateRoomIssueInput {
  roomId: string;
  taskId?: string;
  issueId: string;
  title: string;
  content?: string;
  description?: string;
  origin?: AgentHostRoomIssueOrigin;
  priority?: string;
  dueAtUnix?: number;
}

export interface AgentHostUpdateRoomIssueInput {
  roomId: string;
  taskId?: string;
  issueId: string;
  title?: string;
  content?: string;
  description?: string;
  status?: string;
  priority?: string;
  dueAtUnix?: number;
}

export interface AgentHostDeleteRoomIssueInput {
  roomId: string;
  taskId?: string;
  issueId: string;
}

export interface AgentHostAddRoomIssueContextRefInput {
  refType: string;
  path: string;
  displayName?: string;
}

export interface AgentHostAddRoomIssueContextRefsInput {
  roomId: string;
  taskId?: string;
  issueId: string;
  refs: AgentHostAddRoomIssueContextRefInput[];
}

export interface AgentHostRemoveRoomIssueContextRefInput {
  roomId: string;
  taskId?: string;
  issueId: string;
  contextRefId: string;
}

export interface AgentHostCreateIssueRunInput {
  roomId: string;
  taskId?: string;
  issueId: string;
  runId: string;
  agentProvider: "codex" | "claude-code" | "nexight" | "gemini" | string;
  agentUserId?: string;
  agentSessionId?: string;
}

export interface AgentHostCompleteIssueRunOutputInput {
  outputId: string;
  path: string;
  displayName?: string;
  mediaType?: string;
  sizeBytes?: number;
}

export interface AgentHostCompleteIssueRunInput {
  roomId: string;
  taskId?: string;
  issueId: string;
  runId: string;
  status: "completed" | "failed" | "canceled" | string;
  summary?: string;
  errorMessage?: string;
  outputs: AgentHostCompleteIssueRunOutputInput[];
}

export interface AgentHostGetRoomIssueInput {
  roomId: string;
  taskId?: string;
  issueId: string;
}

export interface AgentHostGetRoomIssueRunInput {
  roomId: string;
  taskId?: string;
  issueId: string;
  runId: string;
}

export interface AgentHostRoomIssueRunEnvelope {
  run: AgentHostRoomIssueRun;
  outputs: AgentHostRoomIssueRunOutput[];
}

export type AgentHostRoomShareInviteStatus =
  | "empty"
  | "pending"
  | "used"
  | "revoked";

export interface AgentHostRoomShareMember {
  userId: string;
  displayName?: string;
  email?: string;
  /** Public HTTPS URL for profile image when available (from share state API). */
  avatarUrl?: string;
  role: AgentHostRoomRole;
  joinedAtUnix?: number;
}

export interface AgentHostRoomShareInviteSlot {
  inviteId?: string;
  roomId?: string;
  slotIndex?: number;
  inviteCode?: string;
  status: AgentHostRoomShareInviteStatus;
  createdBy?: string;
  usedBy?: string;
  revokedBy?: string;
  createdAtUnix?: number;
  usedAtUnix?: number;
  revokedAtUnix?: number;
}

export interface AgentHostRoomShareState {
  roomId: string;
  maxCollaborators: number;
  maxActiveInvites: number;
  collaboratorCount: number;
  remainingCollaboratorSlots: number;
  activeInviteCount: number;
  remainingActiveInviteSlots: number;
  members: AgentHostRoomShareMember[];
  invites: AgentHostRoomShareInviteSlot[];
  visitorShareLink?: AgentHostRoomVisitorShareLinkCredential;
}

export interface AgentHostRoomShareStateInput {
  roomId: string;
}

export interface AgentHostRoomVisitorShareLinkState {
  roomId: string;
  enabled: boolean;
  shareDirectoryTree: boolean;
  shareHistory: boolean;
  createdAtUnix?: number | string;
  updatedAtUnix?: number | string;
}

export interface AgentHostRoomVisitorShareLinkCredential {
  state?: AgentHostRoomVisitorShareLinkState;
  shareToken?: string;
}

export interface AgentHostCreateRoomVisitorShareLinkInput {
  roomId: string;
  shareDirectoryTree: boolean;
  shareHistory: boolean;
}

export interface AgentHostCreateRoomVisitorShareLinkResult {
  link?: AgentHostRoomVisitorShareLinkCredential;
}

export interface AgentHostUpdateRoomVisitorShareLinkInput {
  roomId: string;
  shareDirectoryTree: boolean;
  shareHistory: boolean;
}

export interface AgentHostUpdateRoomVisitorShareLinkResult {
  state?: AgentHostRoomVisitorShareLinkState;
}

export interface AgentHostDisableRoomVisitorShareLinkInput {
  roomId: string;
}

export interface AgentHostDisableRoomVisitorShareLinkResult {
  state?: AgentHostRoomVisitorShareLinkState;
}

export type AgentHostWorkspaceAgentProvider = "codex" | "claude-code" | string;
export type AgentHostWorkspaceAgentSessionOrigin =
  | "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
  | string;
export type AgentHostWorkspaceAgentPresenceStatus =
  | "working"
  | "paused"
  | string;
export type AgentHostWorkspaceAgentSessionLifecycleStatus =
  | "active"
  | "ended"
  | "failed"
  | string;
export type AgentHostWorkspaceAgentTurnPhase =
  | "idle"
  | "working"
  | "waiting_approval"
  | "waiting_input"
  | "failed"
  | string;
export type AgentHostWorkspaceAgentEffectiveStatus =
  | "idle"
  | "working"
  | "waiting"
  | "ready"
  | "completed"
  | "failed"
  | string;
export type AgentHostWorkspaceAgentSessionStatus =
  | "idle"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled"
  | string;
export type AgentHostWorkspaceAgentSyncStatus =
  | "pending"
  | "synced"
  | "failed"
  | string;

export interface AgentHostWorkspaceAgentPresence {
  id: number;
  workspaceId: string;
  userId: string;
  provider: AgentHostWorkspaceAgentProvider;
  status: AgentHostWorkspaceAgentPresenceStatus;
}

export interface AgentHostWorkspaceAgentSession {
  id: number;
  workspaceId?: string;
  agentSessionId: string;
  presenceId: number;
  userId?: string;
  provider?: AgentHostWorkspaceAgentProvider;
  providerSessionId: string;
  resumable?: boolean;
  sessionOrigin?: AgentHostWorkspaceAgentSessionOrigin;
  cwd: string;
  lifecycleStatus?: AgentHostWorkspaceAgentSessionLifecycleStatus;
  turnPhase?: AgentHostWorkspaceAgentTurnPhase;
  endedAtUnixMs?: number;
  startedAtUnixMs?: number;
  createdAtUnixMs?: number;
  updatedAtUnixMs?: number;
  pinnedAtUnixMs?: number | null;
  effectiveStatus?: AgentHostWorkspaceAgentEffectiveStatus;
  title?: string;
  status?: AgentHostWorkspaceAgentSessionStatus;
  syncState?: AgentHostWorkspaceAgentSyncState;
}

export interface AgentHostWorkspaceAgentSyncState {
  workspaceId?: string;
  agentSessionId?: string;
  status: AgentHostWorkspaceAgentSyncStatus;
  pendingTimelineItemCount?: number;
  pendingStatePatchCount?: number;
  attemptCount?: number;
  failedReportCount?: number;
  lastError?: string;
  lastAttemptAtUnixMs?: number;
  lastSyncedAtUnixMs?: number;
  updatedAtUnixMs?: number;
}

export interface AgentHostWorkspaceAgentListInput {
  workspaceId?: string | null;
  sessionOrigin?: AgentHostWorkspaceAgentSessionOrigin;
  userId?: string;
}

export interface AgentHostWorkspaceAgentSnapshot {
  presences: AgentHostWorkspaceAgentPresence[];
  sessions: AgentHostWorkspaceAgentSession[];
  sessionMessagesById?: Record<string, AgentHostWorkspaceAgentMessage[]>;
}

export interface AgentHostDeleteWorkspaceAgentSessionInput {
  workspaceId?: string | null;
  agentSessionId: string;
  sessionOrigin?: AgentHostWorkspaceAgentSessionOrigin;
}

export interface AgentHostDeleteWorkspaceAgentSessionResult {}

export interface AgentHostWorkspaceAgentFileChange {
  path: string;
  change?: "added" | "modified" | "deleted" | "moved" | string;
  tools?: string[];
}

export interface AgentHostWorkspaceAgentFileChanges {
  coverage?: string;
  files?: AgentHostWorkspaceAgentFileChange[];
}

export interface AgentHostWorkspaceAgentTimelineItem {
  id: number;
  workspaceId?: string;
  agentSessionId: string;
  seq?: number;
  turnId?: string;
  eventSource?: string;
  eventId: string;
  actorType: string;
  actorId: string;
  itemType: "message" | "call" | "event" | "error" | "lifecycle" | string;
  role?: string;
  callType?: "tool" | "skill" | "subagent" | "approval" | "workflow" | string;
  callId?: string;
  name?: string;
  status?: string;
  content?: string;
  payload?: Record<string, unknown> & {
    content?: unknown;
    text?: unknown;
    fileChanges?: AgentHostWorkspaceAgentFileChanges;
  };
  occurredAtUnixMs?: number;
  createdAtUnixMs?: number;
}

export interface AgentHostWorkspaceAgentTurnStatePatch {
  turnId: string;
  phase?: string;
  outcome?: string;
  fileChanges?: Record<string, unknown>;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
}

export interface AgentHostWorkspaceAgentEntityStatePatch {
  callId: string;
  turnId?: string;
  callType?: string;
  name?: string;
  status?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
}

export interface AgentHostWorkspaceAgentStatePatch {
  workspaceId?: string;
  agentSessionId: string;
  provider?: string;
  providerSessionId?: string;
  model?: string;
  permissionModeId?: string;
  settings?: {
    model?: string | null;
    reasoningEffort?: string | null;
    planMode?: boolean;
    permissionModeId?: string | null;
  };
  runtimeContext?: Record<string, unknown>;
  cwd?: string;
  title?: string;
  lifecycleStatus?: string;
  currentPhase?: string;
  lastError?: string;
  occurredAtUnixMs?: number;
  turn?: AgentHostWorkspaceAgentTurnStatePatch;
  entities?: AgentHostWorkspaceAgentEntityStatePatch[];
}

export interface AgentHostWorkspaceAgentMessage {
  id: number;
  workspaceId?: string;
  agentSessionId: string;
  messageId: string;
  version: number;
  turnId: string;
  role: string;
  kind: string;
  status?: string;
  payload: Record<string, unknown>;
  occurredAtUnixMs: number;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
}

export interface AgentHostWorkspaceAgentSessionMessagesInput {
  workspaceId?: string | null;
  agentSessionId: string;
  afterVersion?: number;
  beforeVersion?: number;
  limit?: number;
  order?: "asc" | "desc";
  sessionOrigin?: AgentHostWorkspaceAgentSessionOrigin;
}

export interface AgentHostWorkspaceAgentSessionMessages {
  messages: AgentHostWorkspaceAgentMessage[];
  latestVersion?: number;
  hasMore?: boolean;
}

export interface AgentHostWorkspaceAgentSessionSummaryItem {
  id?: number;
  turnId?: string;
  actorType?: string;
  actorId?: string;
  itemType?: string;
  role?: string;
  callType?: string;
  callId?: string;
  name?: string;
  status?: string;
  content?: string;
  occurredAtUnixMs?: number;
  createdAtUnixMs?: number;
}

export interface AgentHostWorkspaceAgentSessionSummaryTurn {
  turnId?: string;
  userItems: AgentHostWorkspaceAgentSessionSummaryItem[];
  agentItems: AgentHostWorkspaceAgentSessionSummaryItem[];
}

export interface AgentHostWorkspaceAgentSessionExecutionStatus {
  currentOrFinalStatus?: string;
  status?: AgentHostWorkspaceAgentSessionStatus;
}

export interface AgentHostWorkspaceAgentSessionSummaryInput {
  workspaceId?: string | null;
  agentSessionId: string;
  agentReplyLimit?: number;
  recentTurnLimit?: number;
}

export interface AgentHostWorkspaceAgentSessionSummary {
  agentSessionId: string;
  initialUserRequirement?: string;
  latestUserRequirement?: string;
  recentAgentReplies: string[];
  currentOrFinalStatus?: string;
  initialTurn?: AgentHostWorkspaceAgentSessionSummaryTurn | null;
  latestTurn?: AgentHostWorkspaceAgentSessionSummaryTurn | null;
  latestTurnSameAsInitial?: boolean;
  recentTurns: AgentHostWorkspaceAgentSessionSummaryTurn[];
  executionStatus?: AgentHostWorkspaceAgentSessionExecutionStatus | null;
}

export interface AgentHostRevokeRoomShareInviteInput {
  roomId: string;
  inviteId: string;
}

export interface AgentHostRoomCollabStatus {
  roomId: string;
  completedAtUnix: number;
  completedBy: string;
  ownerUnreadCompletion: boolean;
  /** Internal hint: explicit enter should wait for full template bootstrap completion. */
  waitForFinalBootstrap?: boolean;
}

export interface AgentHostRoomEnvelope {
  room: AgentHostRoomSummary;
}

export interface AgentHostJoinSharedRoomResult extends AgentHostRoomEnvelope {
  /** Internal hint: explicit enter should wait for full template bootstrap completion. */
  waitForFinalBootstrap?: boolean;
}

export interface AgentHostEnterRoomInput {
  roomId: string;
  /** Renderer-only hint: open the room issue manager on this issue after the room window is shown. */
  pendingIssueId?: string | null;
  /** Internal: pending room window request to promote from pending to entered on success. */
  pendingRoomWindowRequestId?: string | null;
  /** Whether to install OpenClaw CLI during workspace enter. */
  installOpenclaw?: boolean;
  /** Client-generated operation id used to subscribe to backend progress events. */
  operationId?: string;
  /** Internal: wait for the full /enter response instead of recovering from current workspace state. */
  waitForFinalBootstrap?: boolean;
}

export interface AgentHostToolchainApplySummary {
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  changed: boolean;
}

export interface AgentHostEnterRoomResult {
  status: string;
  room: AgentHostRoomSummary;
  workspaceRoot: string;
  linuxUser: string;
  provider: string;
  sandboxId: string;
  toolchainApply?: AgentHostToolchainApplySummary;
  templateBootstrap?: AgentHostTemplateBootstrapResult;
}

export type AgentHostTemplateBootstrapActionType =
  | "open_browser"
  | "open_template_app";

export type AgentHostTemplateBootstrapAction =
  | {
      type: "open_browser";
      url?: string;
    }
  | {
      type: "open_template_app";
      appId: string;
      title: string;
      launchUrl: string;
      reuseIfOpen?: boolean;
    };

export interface AgentHostTemplateBootstrapRuntime {
  port: number;
  url: string;
  workspaceAppDir?: string;
  helperScriptPath?: string;
}

export interface AgentHostTemplateBootstrapPayload {
  schemaVersion: string;
  status: "ok" | "error";
  runtime?: AgentHostTemplateBootstrapRuntime;
  actions?: AgentHostTemplateBootstrapAction[];
}

export interface AgentHostTemplateBootstrapResult {
  templateId: string;
  status: "succeeded" | "failed";
  result?: AgentHostTemplateBootstrapPayload;
  error?: string;
}

export interface AgentHostTerminalSession {
  id: string;
  roomId?: string | null;
  cwd: string;
  cols: number;
  rows: number;
  state?: AgentHostTerminalSessionState;
  exitCode?: number | null;
  lostReason?: string;
  attachedCount?: number;
  lastSeq?: number;
  createdAt: number;
  updatedAt: number;
}

export type AgentHostTerminalSessionState =
  | "created"
  | "starting"
  | "running"
  | "detached"
  | "exited"
  | "lost"
  | "closed";

export interface AgentHostCurrentRoomResult {
  connected: boolean;
  room?: AgentHostRoomSummary;
  workspaceRoot?: string;
  linuxUser?: string;
  provider?: string;
  sandboxId?: string;
  roomKey?: AgentHostRoomKey;
  terminalSessions?: AgentHostTerminalSession[];
  templateBootstrap?: AgentHostTemplateBootstrapResult;
  disconnectedReason?: string;
  reconnectable?: boolean;
}

export interface AgentHostRoomSurfaceResult {
  current: AgentHostCurrentRoomResult;
  runtimeStatus: AgentHostRuntimeStatusResult;
  tree?: AgentHostRoomTreeResult;
}

export interface AgentHostRoomSnapshot {
  roomId: string;
  current: AgentHostCurrentRoomResult;
  runtimeStatus: AgentHostRuntimeStatusResult;
  tree?: AgentHostRoomTreeResult;
  activeTerminals: AgentHostTerminalSession[];
  agents?: AgentHostWorkspaceAgentSnapshot | null;
  receivedAtUnixMs?: number;
}

export interface AgentHostTemplateCatalogProjection {
  status: "idle" | "loading" | "ready" | "error";
  templates: AgentHostWorkspaceTemplate[];
  errorMessage: string | null;
}

export interface AgentHostWorkspaceHistoryProjectionItem {
  workspaceId: string;
  name: string;
  lastUsedUnix: number;
  role?: AgentHostRoomRole;
  relationship?: Exclude<AgentHostRoomRelationship, "all">;
  templateId?: string;
  templateManifestUrl?: string;
  statusSnapshot?: AgentHostRoomStatus;
}

export interface AgentHostRoomSnapshotEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-snapshot";
  roomId: string;
  snapshot: AgentHostRoomSnapshot;
}

export interface AgentHostRoomTreeUpdateEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-tree-update";
  roomId: string;
  tree: AgentHostRoomTreeResult;
}

export interface AgentHostWorkspaceAgentUpdateEvent extends AgentHostEventBase {
  scope: "room";
  type: "workspace-agent-update";
  workspaceId: string;
  sessionOrigin?: AgentHostWorkspaceAgentSessionOrigin;
  agents: AgentHostWorkspaceAgentSnapshot;
}

export interface AgentHostRoomTerminalUpdateEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-terminal-update";
  roomId: string;
  terminals: AgentHostTerminalSession[];
}

export interface AgentHostRuntimeStatusEvent extends AgentHostEventBase {
  scope: "global";
  type: "runtime-status";
  runtimeStatus: AgentHostRuntimeStatusResult;
}

export interface AgentHostDirectoryUpdateEvent extends AgentHostEventBase {
  scope: "global";
  type: "directory-update";
  directory: AgentHostRoomSummary[];
  replace?: boolean;
  room?: AgentHostRoomSummary | null;
  deletedRoomId?: string | null;
  lastUsedUnix?: number;
}

export interface AgentHostRoomUserSnapshotUpdateEvent extends AgentHostEventBase {
  scope: "global";
  type: "room-user-snapshot-updated";
  roomId: string;
  userSnapshot: AgentHostRoomUserSnapshot;
}

export interface AgentHostTemplateCatalogEvent extends AgentHostEventBase {
  scope: "global";
  type: "template-catalog";
  templateCatalog: AgentHostTemplateCatalogProjection;
}

export interface AgentHostWorkspaceHistoryEvent extends AgentHostEventBase {
  scope: "global";
  type: "workspace-history";
  workspaceHistory: AgentHostWorkspaceHistoryProjectionItem[];
}

export interface AgentHostManagedAgentsStateEvent extends AgentHostEventBase {
  scope: "global";
  type: "managed-agents-state";
  managedAgentsState: AgentHostManagedAgentsState;
}

export type AgentHostManagedAgentActionProgressStage =
  | "cache_hit"
  | "download_start"
  | "downloading"
  | "retrying"
  | "validating"
  | "succeeded"
  | "failed";

export interface AgentHostManagedAgentActionProgress {
  agentId: string;
  packageName: string;
  stage: AgentHostManagedAgentActionProgressStage;
  attempt?: number;
  maxAttempts?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  resumable: boolean;
  errorCode?: string;
  message?: string;
}

export interface AgentHostManagedAgentActionProgressEvent extends AgentHostEventBase {
  scope: "global";
  type: "managed-agent-action-progress";
  progress: AgentHostManagedAgentActionProgress;
}

export interface AgentHostAgentModelCatalogInvalidatedEvent extends AgentHostEventBase {
  scope: "global";
  type: "agent-model-catalog-invalidated";
  providers: import("./agent").AgentProviderId[];
  occurredAtUnixMs: number;
}

export interface AgentHostBootstrapResult {
  mockSession: AgentHostMockSession;
  capabilities: AgentHostCapabilitiesResult;
  managedAgentsState: AgentHostManagedAgentsState;
  surface: AgentHostRoomSurfaceResult;
}

export interface AgentHostCreateAndEnterResult {
  room: AgentHostRoomSummary;
  enter: AgentHostEnterRoomResult;
}

export interface AgentHostSandboxClosingPayload {
  reason: string;
  gracePeriodSeconds: number;
}

export type AgentHostEventScope = "global" | "room" | "window";

interface AgentHostEventBase {
  scope: AgentHostEventScope;
  roomId?: string | null;
  room?: AgentHostRoomSummary | null;
  inviteCode?: string | null;
  issueId?: string | null;
  pendingIssueNavigationRequested?: boolean | null;
  sessionId?: string | null;
  sandboxClosing?: AgentHostSandboxClosingPayload;
  sourceNodeId?: string | null;
  progress?: unknown;
  roomWindowBindingStatus?: "pending" | "entered";
}

export interface AgentHostRoomCreatedEvent extends AgentHostEventBase {
  scope: "global";
  type: "room-created";
  roomId: string;
  room?: AgentHostRoomSummary | null;
}

export interface AgentHostRoomUpdatedEvent extends AgentHostEventBase {
  scope: "global";
  type: "room-updated";
  roomId: string;
  room: AgentHostRoomSummary;
}

export interface AgentHostRoomLeftEvent extends AgentHostEventBase {
  scope: "global";
  type: "room-left";
  roomId: string | null;
}

export interface AgentHostRuntimeResetEvent extends AgentHostEventBase {
  scope: "global";
  type: "runtime-reset";
  roomId?: string | null;
}

export interface AgentHostOpenShareModalEvent extends AgentHostEventBase {
  scope: "global";
  type: "open-share-modal";
}

export interface AgentHostAccountSnapshotChangedEvent extends AgentHostEventBase {
  scope: "global";
  type: "account-snapshot-changed";
  snapshot: AgentHostAccountSnapshot;
}

export interface AgentHostDiagnosticsExportEvent extends AgentHostEventBase {
  scope: "global";
  type: "diagnostics-export";
  phase: "running" | "completed" | "failed";
}

export interface AgentHostSandboxClosingEvent extends AgentHostEventBase {
  scope: "room";
  type: "sandbox-closing";
  roomId: string;
  sandboxClosing: AgentHostSandboxClosingPayload;
}

export interface AgentHostTerminalLifecycleEvent extends AgentHostEventBase {
  scope: "room";
  type: "terminal-created" | "terminal-closed" | "terminal-exited";
  roomId: string;
  sessionId?: string | null;
}

export interface AgentHostRoomEnterProgressEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-enter-progress";
  roomId: string;
  progress: import("./workspaceEnterProgress").WorkspaceEnterProgressEvent;
}

export interface AgentHostRoomEnteredEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-entered";
  roomId: string;
  room: AgentHostRoomSummary;
}

export interface AgentHostOpenAgentSessionEvent extends AgentHostEventBase {
  scope: "room";
  type: "open-agent-session";
  roomId: string;
  sessionId: string;
  sourceNodeId: string;
}

export interface AgentHostRoomWindowBoundEvent extends AgentHostEventBase {
  scope: "window";
  type: "room-window-bound";
  roomId: string;
  pendingIssueId?: string | null;
  pendingIssueNavigationRequested?: boolean;
  roomWindowBindingStatus?: "pending" | "entered";
  pendingRoomWindowRequestId?: string | null;
  waitForFinalBootstrap?: boolean;
}

export interface AgentHostRoomEnterRequestedEvent extends AgentHostEventBase {
  scope: "window";
  type: "room-enter-requested";
  roomId: string;
  pendingIssueId?: string | null;
  pendingRoomWindowRequestId?: string | null;
  waitForFinalBootstrap?: boolean;
}

export interface AgentHostRoomShareLinkOpenedEvent extends AgentHostEventBase {
  scope: "window";
  type: "room-share-link-opened";
  roomId: string;
  inviteCode?: string | null;
  issueId?: string | null;
}

export type AgentHostEvent =
  | AgentHostRoomCreatedEvent
  | AgentHostRoomUpdatedEvent
  | AgentHostRoomEnteredEvent
  | AgentHostRoomLeftEvent
  | AgentHostRuntimeResetEvent
  | AgentHostSandboxClosingEvent
  | AgentHostTerminalLifecycleEvent
  | AgentHostOpenShareModalEvent
  | AgentHostAccountSnapshotChangedEvent
  | AgentHostDiagnosticsExportEvent
  | AgentHostRoomShareLinkOpenedEvent
  | AgentHostRoomEnterProgressEvent
  | AgentHostRoomWindowBoundEvent
  | AgentHostRoomEnterRequestedEvent
  | AgentHostOpenAgentSessionEvent
  | AgentHostRoomSnapshotEvent
  | AgentHostRoomTreeUpdateEvent
  | AgentHostWorkspaceAgentUpdateEvent
  | AgentHostRoomTerminalUpdateEvent
  | AgentHostRuntimeStatusEvent
  | AgentHostDirectoryUpdateEvent
  | AgentHostRoomUserSnapshotUpdateEvent
  | AgentHostTemplateCatalogEvent
  | AgentHostWorkspaceHistoryEvent
  | AgentHostManagedAgentsStateEvent
  | AgentHostManagedAgentActionProgressEvent
  | AgentHostAgentModelCatalogInvalidatedEvent;

export interface AgentHostLeaveRoomResult {
  disconnected: boolean;
  closedTerminals: number;
}

export interface AgentHostLeaveRoomMembershipResult {
  roomId: string;
  left: boolean;
  disconnected: boolean;
  closedTerminals: number;
}

export interface AgentHostRuntimeStatusResult {
  connected: boolean;
  runtimeId?: string;
  activeRoomIds?: string[];
  vmState?: string;
  vmStatus?: string;
  healthDetailCode?: string;
  runtimeConnectionLost?: boolean;
  healthVerified?: boolean;
  healthy?: boolean;
  healthState?: "healthy" | "pending" | "unhealthy" | string;
  detail?: string;
  sandboxSessionState?: "connected" | "reconnecting" | "disconnected";
  panicDetected?: boolean;
  panicExcerpt?: string;
}

export interface AgentHostRuntimeWorkspaceDebugResult {
  vm: {
    connected: boolean;
    state?: string;
    healthState?: string;
    statusMessage?: string;
    imageBootSource?: "new_base" | "active" | "stable" | "base" | string;
    guestAgentRelaySocket?: string;
    sandboxSessionState?:
      | "connected"
      | "reconnecting"
      | "disconnected"
      | "unknown"
      | string;
    diagnosticsStatusMessage?: string;
    panicDetected?: boolean;
    panicExcerpt?: string;
    restartCount: number;
    phases?: AgentHostRuntimeWorkspaceDebugPhase[];
    trace?: AgentHostRuntimeWorkspaceDebugPhase[];
  };
  workspaces: AgentHostRuntimeWorkspaceDebugItem[];
}

export interface AgentHostRuntimeWorkspaceDebugPhase {
  stage: string;
  message?: string;
  status: "started" | "succeeded" | "failed" | string;
  elapsedMs?: number;
  totalElapsedMs?: number;
  attempt?: number;
  imageBootSource?: "new_base" | "active" | "stable" | "base" | string;
  errorLog?: string;
  updatedAt?: string;
}

export interface AgentHostRuntimeWorkspaceDebugItem {
  workspaceId: string;
  roomId?: string;
  roomName?: string;
  state?: string;
  statusMessage?: string;
  mountPoint?: string;
  authorityId?: string;
  sandboxId?: string;
  attached?: boolean;
  attachedAt?: string;
  updatedAt?: string;
  allow?: string[];
  websocket: {
    state:
      | "connected"
      | "reconnecting"
      | "disconnected"
      | "not_started"
      | "unknown"
      | string;
    routeKind?: string;
    subprotocol?: string;
    createdAt?: string;
    lastConnectedAt?: string;
    lastDisconnectedAt?: string;
    reconnectCount: number;
    lastError?: string;
  };
  trace?: AgentHostRuntimeWorkspaceDebugPhase[];
}

export interface AgentHostRuntimeArtifactState {
  status: "idle" | "checking" | "downloading" | "verifying" | "ready" | "error";
  runtimeArtifactVersion: string | null;
  downloadPercent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  message: string | null;
}

export interface AgentHostRuntimeService {
  port: number;
  previewUrl?: string;
}

export interface AgentHostRuntimeServicesResult {
  connected: boolean;
  roomId?: string;
  statusMessage?: string;
  services: AgentHostRuntimeService[];
}

export interface AgentHostRuntimeResetResult {
  restarted: boolean;
  runtimeId?: string;
  activeRoomIds?: string[];
  reAttachedRoomIds?: string[];
  reAttachFailedRoomIds?: string[];
  vmState?: string;
  vmStatus?: string;
}

export interface AgentHostRuntimePrewarmInput {
  reason?: string;
}

export interface AgentHostRuntimePrewarmResult {
  started: boolean;
  inFlight: boolean;
  reason?: string;
}

export interface AgentHostRuntimeOpenclawGatewayWarmupResult {
  accepted: boolean;
  ready?: boolean;
}

export interface AgentHostRoomTreeInput {
  roomId?: string;
  path?: string;
  depth?: number;
}

export interface AgentHostRoomTreeNode {
  path: string;
  name: string;
  kind: "file" | "directory" | "unknown";
  hasChildren: boolean;
}

export interface AgentHostRoomTreeResult {
  roomId: string;
  root: string;
  nodes: AgentHostRoomTreeNode[];
}

export interface AgentHostCreateTerminalInput {
  roomId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  hidden?: boolean;
  initialInput?: string;
  launchCommand?: string[];
  launchEnv?: string[];
}

export interface AgentHostCreateRoomSSHTerminalInput {
  roomId?: string;
  cols?: number;
  rows?: number;
  deviceId?: string;
  deviceLabel?: string;
  preferLocalSSHKey?: boolean;
}

export interface AgentHostCreateVMTerminalInput {
  cwd?: string;
  cols?: number;
  rows?: number;
  initialInput?: string;
  launchCommand?: string[];
  launchEnv?: string[];
}

export interface AgentHostTerminalSnapshotResult {
  session: AgentHostTerminalSession;
  data: string;
  fromSeq: number;
  toSeq: number;
  truncated: boolean;
  updatedAt: number;
}

export type AgentHostTerminalCloseGuardReason =
  | "foreground-process"
  | "not-running"
  | "unknown";

export interface AgentHostTerminalCloseGuardResult {
  requiresConfirmation: boolean;
  reason: AgentHostTerminalCloseGuardReason;
  state: AgentHostTerminalSessionState;
  leaderCommand?: string;
}

export interface AgentHostTerminalSessionEnvelope {
  session: AgentHostTerminalSession;
}

export interface AgentHostTerminalListResult {
  sessions: AgentHostTerminalSession[];
}

export interface AgentHostWriteTerminalInput {
  data: string;
}

export interface AgentHostResizeTerminalInput {
  cols: number;
  rows: number;
}

export interface AgentHostWriteTerminalResult {
  exitCode: number;
}

export interface AgentHostCloseTerminalResult {
  removed: boolean;
}
