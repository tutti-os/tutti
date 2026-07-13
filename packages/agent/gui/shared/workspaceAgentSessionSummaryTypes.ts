export interface WorkspaceAgentActivitySessionSummaryItem {
  id?: number;
  turnId?: string;
  actorType?: string;
  actorId?: string;
  itemType?: string;
  role?: string;
  content?: string;
  title?: string;
  status?: string;
  callType?: string;
  name?: string;
  payload?: Record<string, unknown>;
  occurredAtUnixMs?: number;
}

export interface WorkspaceAgentActivitySessionSummaryTurn {
  turnId: string;
  userItems?: WorkspaceAgentActivitySessionSummaryItem[];
  agentItems?: WorkspaceAgentActivitySessionSummaryItem[];
}

export interface WorkspaceAgentActivitySessionExecutionStatus {
  currentOrFinalStatus?: string;
  updatedAtUnixMs?: number;
}

export interface WorkspaceAgentActivitySessionSummary {
  agentSessionId: string;
  latestUserRequirement?: string;
  initialUserRequirement?: string;
  latestTurn?: WorkspaceAgentActivitySessionSummaryTurn;
  recentAgentReplies?: string[];
  recentTurns?: WorkspaceAgentActivitySessionSummaryTurn[];
  currentOrFinalStatus?: string;
  executionStatus?: WorkspaceAgentActivitySessionExecutionStatus;
}
