import type { AgentActivitySession } from "./types.ts";

export interface AgentActivityForkSessionThroughTurnInput {
  workspaceId: string;
  sourceAgentSessionId: string;
  targetAgentSessionId: string;
  requestId: string;
  turnId: string;
  signal?: AbortSignal;
}

export type AgentActivityForkSessionOperationStatus =
  | "accepted"
  | "committed"
  | "failed"
  | "unknown";

export interface AgentActivityForkSessionResult {
  operationId: string;
  requestId: string;
  sourceAgentSessionId: string;
  targetAgentSessionId: string;
  turnId: string;
  status: AgentActivityForkSessionOperationStatus;
  session: AgentActivitySession | null;
  error: string | null;
}
