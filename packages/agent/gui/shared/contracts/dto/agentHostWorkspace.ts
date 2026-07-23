import type { AgentHostMockSession } from "./agentHostAccount";
import type { AgentHostRoomTreeResult } from "./agentHostFiles";
import type {
  AgentHostCapabilitiesResult,
  AgentHostManagedAgentsState
} from "./agentHostProviderProbe";
import type { AgentHostRuntimeStatusResult } from "./agentHostRuntimePersistence";
import type { AgentHostRoomShareInviteStatus } from "./agentHostWorkspaceSharing";
import type { AgentHostTerminalSession } from "./agentHostTerminal";

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
  assetRef: string;
  assetUrl: string;
  capturedAtUnixMs: string;
}

export interface AgentHostCreateObjectUploadResult {
  uploadId: string;
  assetRef?: string;
  uploadUrl: string;
  headers?: Record<string, string>;
  expiresAt?: string;
}

export interface AgentHostCompleteObjectUploadResult {
  uploadId: string;
  assetRef?: string;
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
  assetRef?: string;
  assetUrl?: string;
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
