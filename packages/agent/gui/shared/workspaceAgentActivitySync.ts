export type WorkspaceAgentActivitySyncStatus =
  | "pending"
  | "synced"
  | "failed"
  | string;

export interface WorkspaceAgentActivitySyncState {
  workspaceId?: string;
  agentSessionId?: string;
  status: WorkspaceAgentActivitySyncStatus;
  pendingTimelineItemCount?: number;
  pendingStatePatchCount?: number;
  attemptCount?: number;
  failedReportCount?: number;
  lastError?: string;
  lastAttemptAtUnixMs?: number;
  lastSyncedAtUnixMs?: number;
  updatedAtUnixMs?: number;
}
