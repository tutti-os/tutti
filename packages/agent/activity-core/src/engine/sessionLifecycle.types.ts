import type {
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivityTurn,
  AgentActivityTurnCancelResponse
} from "../types.ts";

export type SessionCancelStatus =
  | "idle"
  | "awaitingTurn"
  | "requested"
  | "failed";

export interface SessionCancelState {
  commandId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiryId: string | null;
  requestedSessionVersion: number | null;
  turnId: string | null;
  status: SessionCancelStatus;
}

export interface SessionLifecycleRecord {
  activeTurn: AgentActivityTurn | null;
  cancel: SessionCancelState;
  operationError: string | null;
  latestTurn: AgentActivityTurn | null;
  pendingInteractions: readonly AgentActivityInteraction[];
  session: AgentActivitySession;
}

export interface SessionLifecycleState {
  deletedSessionIds: Readonly<Record<string, true>>;
  recordsBySessionId: Readonly<Record<string, SessionLifecycleRecord>>;
}

export interface SessionSnapshotReceivedIntent {
  type: "session/snapshotReceived";
  sessions: readonly AgentActivitySession[];
}

export interface SessionUpsertedIntent {
  type: "session/upserted";
  session: AgentActivitySession;
}

export interface SessionRemovedIntent {
  type: "session/removed";
  agentSessionId: string;
}

export interface SessionErrorRecordedIntent {
  type: "session/errorRecorded";
  agentSessionId: string;
  errorMessage: string;
}

export interface SessionErrorClearedIntent {
  type: "session/errorCleared";
  agentSessionId: string;
}

export interface SessionCancelRequestedIntent {
  type: "session/cancelRequested";
  agentSessionId: string;
  commandId: string;
  awaitingTurnExpiresAtUnixMs: number;
  timeoutMs?: number;
}

export interface SessionCancelAbandonedIntent {
  type: "session/cancelAbandoned";
  agentSessionId: string;
}

export type SessionLifecycleIntent =
  | SessionCancelAbandonedIntent
  | SessionCancelRequestedIntent
  | SessionErrorClearedIntent
  | SessionErrorRecordedIntent
  | SessionRemovedIntent
  | SessionSnapshotReceivedIntent
  | SessionUpsertedIntent;

export interface TurnCancelCommand {
  type: "turn/cancel";
  commandId: string;
  workspaceId: string;
  agentSessionId: string;
  turnId: string;
  timeoutMs?: number;
}

export function isAgentActivityTurnCancelResponse(
  value: unknown
): value is AgentActivityTurnCancelResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const response = value as Partial<AgentActivityTurnCancelResponse>;
  return Boolean(
    response.cancel &&
    typeof response.cancel.canceled === "boolean" &&
    typeof response.cancel.reason === "string"
  );
}
