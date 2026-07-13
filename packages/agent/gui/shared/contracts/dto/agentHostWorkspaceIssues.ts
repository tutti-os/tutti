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
  agentProvider?: "codex" | "claude-code" | "nexight" | string;
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
  agentProvider: "codex" | "claude-code" | "nexight" | string;
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
