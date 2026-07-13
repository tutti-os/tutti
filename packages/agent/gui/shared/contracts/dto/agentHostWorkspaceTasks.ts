import type { AgentHostRoomIssueSummary } from "./agentHostWorkspaceIssues";

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
