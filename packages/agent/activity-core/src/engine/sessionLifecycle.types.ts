import type {
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivityTurn,
  AgentActivityTurnCancelResponse
} from "../types.ts";
import type { AgentActivitySessionInput } from "../sessionNormalization.ts";

export type SessionCancelStatus =
  | "idle"
  | "awaitingTurn"
  | "requested"
  | "accepted"
  | "unknown"
  | "failed";

export interface SessionCancelState {
  commandId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiryId: string | null;
  requestedSessionVersion: number | null;
  requestedWorkspaceId: string | null;
  turnId: string | null;
  status: SessionCancelStatus;
}

export interface SessionOperationState {
  runtimeAvailability: SessionRuntimeAvailability;
  cancel: SessionCancelState;
  operationError: string | null;
  settingsUpdate: SessionSettingsUpdateState;
}

/**
 * Host-projected, session-scoped availability for commands that must reach the
 * session runtime. This is intentionally separate from the canonical Session:
 * transport reachability and exact-target Agent capabilities are ephemeral and
 * may differ between Sessions sharing one workspace engine.
 */
export type SessionRuntimeAvailability =
  | { state: "available" }
  | {
      state: "blocked";
      reason:
        | "agent_capability_checking"
        | "agent_capability_unavailable"
        | "transport_reconnecting"
        | "transport_unavailable";
    };

export type SessionSettingsUpdateStatus =
  | "idle"
  | "inFlight"
  | "waitingForRuntime"
  | "failed"
  | "unknown";

export interface SessionSettingsUpdateState {
  commandId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedCommandId: string | null;
  queuedSettings: Readonly<Record<string, unknown>> | null;
  settings: Readonly<Record<string, unknown>> | null;
  status: SessionSettingsUpdateStatus;
}

export type InteractionResponseStatus = "responding" | "failed" | "unknown";

export interface InteractionResponseState {
  action: string | null;
  agentSessionId: string;
  commandId: string;
  errorCode: string | null;
  errorMessage: string | null;
  optionId: string | null;
  payload: Readonly<Record<string, unknown>> | null;
  requestId: string;
  retry?: boolean;
  status: InteractionResponseStatus;
  turnId: string;
  workspaceId: string;
}

export type CanonicalAgentSession = Omit<
  AgentActivitySession,
  "activeTurn" | "latestTurn" | "latestTurnInteractions" | "pendingInteractions"
> & {
  activeTurnId: string | null;
};

export interface SessionLifecycleState {
  deletedSessionIds: Readonly<Record<string, true>>;
  interactionsById: Readonly<Record<string, AgentActivityInteraction>>;
  interactionResponsesById: Readonly<Record<string, InteractionResponseState>>;
  operationBySessionId: Readonly<Record<string, SessionOperationState>>;
  sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
  turnsById: Readonly<Record<string, AgentActivityTurn>>;
}

export interface SessionSnapshotReceivedIntent {
  type: "session/snapshotReceived";
  sessions: readonly AgentActivitySessionInput[];
}

export interface SessionUpsertedIntent {
  type: "session/upserted";
  session: AgentActivitySessionInput;
}

export interface SessionMetadataPatchedIntent {
  type: "session/metadataPatched";
  agentSessionId: string;
  patch: Partial<
    Pick<
      CanonicalAgentSession,
      "cwd" | "pinnedAtUnixMs" | "resumable" | "title" | "updatedAtUnixMs"
    >
  >;
}

export interface TurnUpsertedIntent {
  type: "turn/upserted";
  turn: AgentActivityTurn;
}

export interface InteractionUpsertedIntent {
  type: "interaction/upserted";
  interaction: AgentActivityInteraction;
}

export interface InteractionResponseRequestedIntent {
  type: "interaction/responseRequested";
  action?: string;
  agentSessionId: string;
  commandId: string;
  optionId?: string;
  payload?: Readonly<Record<string, unknown>>;
  requestId: string;
  turnId: string;
  retry?: boolean;
  timeoutMs?: number;
  workspaceId: string;
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
  workspaceId: string;
}

export interface SessionStopRequestedIntent {
  type: "session/stopRequested";
  agentSessionId: string;
  commandId: string;
  awaitingTurnExpiresAtUnixMs: number;
  timeoutMs?: number;
  workspaceId: string;
}

export interface SessionCancelAbandonedIntent {
  type: "session/cancelAbandoned";
  agentSessionId: string;
}

export interface SessionSettingsUpdateRequestedIntent {
  type: "session/settingsUpdateRequested";
  agentSessionId: string;
  commandId: string;
  settings: Readonly<Record<string, unknown>>;
  retry?: boolean;
  timeoutMs?: number;
  workspaceId: string;
}

export interface SessionRuntimeAvailabilityChangedIntent {
  type: "session/runtimeAvailabilityChanged";
  agentSessionId: string;
  availability: SessionRuntimeAvailability;
}

export type SessionLifecycleIntent =
  | InteractionUpsertedIntent
  | InteractionResponseRequestedIntent
  | SessionCancelAbandonedIntent
  | SessionCancelRequestedIntent
  | SessionErrorClearedIntent
  | SessionErrorRecordedIntent
  | SessionMetadataPatchedIntent
  | SessionRemovedIntent
  | SessionRuntimeAvailabilityChangedIntent
  | SessionSettingsUpdateRequestedIntent
  | SessionSnapshotReceivedIntent
  | SessionStopRequestedIntent
  | SessionUpsertedIntent
  | TurnUpsertedIntent;

export interface TurnCancelCommand {
  type: "turn/cancel";
  commandId: string;
  workspaceId: string;
  agentSessionId: string;
  turnId: string;
  timeoutMs?: number;
}

export interface InteractionRespondCommand {
  type: "interaction/respond";
  action?: string;
  agentSessionId: string;
  commandId: string;
  correlationId: string;
  optionId?: string;
  payload?: Readonly<Record<string, unknown>>;
  requestId: string;
  turnId: string;
  timeoutMs?: number;
  workspaceId: string;
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
