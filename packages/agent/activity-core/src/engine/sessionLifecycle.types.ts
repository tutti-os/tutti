import type {
  AgentActivityDurableMessage,
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivityTurn,
  AgentActivityTurnCancelResponse
} from "../types.ts";
import type { AgentActivitySessionInput } from "../sessionNormalization.ts";
import type { AgentActivitySessionMessageWindow } from "../messageWindow.types.ts";
import type { AgentActivityEditRetryAvailability } from "./editRetry.types.ts";

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
  targetClientSubmitId: string | null;
  turnId: string | null;
  status: SessionCancelStatus;
}

export interface SessionOperationState {
  runtimeAvailability: SessionRuntimeAvailability;
  runtimeActivity: SessionRuntimeActivity;
  runtimeActivityOccurredAtUnixMs: number;
  cancel: SessionCancelState;
  operationError: string | null;
  settingsUpdate: SessionSettingsUpdateState;
}

export type SessionRuntimeActivity = "idle" | "running";

/**
 * Host-projected, session-scoped availability for commands that must reach the
 * session runtime. This is intentionally separate from the canonical Session:
 * transport reachability, exact-target Agent capabilities, and shared access
 * are ephemeral and may differ between Sessions sharing one workspace engine.
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
    }
  | {
      state: "blocked";
      reason: "agent_sharing_revoked";
      ownerLabel: string;
    };

export type SessionSettingsUpdateStatus =
  | "idle"
  | "inFlight"
  | "waitingForPromptSend"
  | "waitingForRuntime"
  | "failed"
  | "unknown";

export interface SessionSettingsUpdateState {
  commandId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedCommandId: string | null;
  queuedRequests: readonly {
    commandId: string;
    kind: "activation" | "promptPrecondition" | "user";
    settings: Readonly<Record<string, unknown>>;
    timeoutMs?: number;
  }[];
  queuedSettings: Readonly<Record<string, unknown>> | null;
  requestKind: "activation" | "promptPrecondition" | "user" | null;
  settings: Readonly<Record<string, unknown>> | null;
  status: SessionSettingsUpdateStatus;
  timeoutMs: number | null;
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
  observedAtUnixMs?: number;
  /** Session ids filtered at the Engine identity boundary for wrong scope. */
  workspaceMismatchSessionIds?: readonly string[];
}

export interface SessionUpsertedIntent {
  type: "session/upserted";
  session: AgentActivitySessionInput;
  observedAtUnixMs?: number;
}

export type CanonicalSessionMetadataPatch = Partial<
  Pick<
    CanonicalAgentSession,
    | "cwd"
    | "goal"
    | "pinnedAtUnixMs"
    | "resumable"
    | "title"
    | "updatedAtUnixMs"
  >
>;

export interface SessionMetadataPatchedIntent {
  type: "session/metadataPatched";
  agentSessionId: string;
  patch: CanonicalSessionMetadataPatch;
}

export interface TurnUpsertedIntent {
  type: "turn/upserted";
  /**
   * Whether this upsert is a live observation capable of creating attention.
   * Historical detail hydration uses false while preserving the same
   * canonical lifecycle write. Omission remains compatible with older hosts
   * and is treated as a live observation.
   */
  live?: boolean;
  /**
   * Internal replay of an already accepted live completion after reconcile
   * supplied Session identity. It may create attention even though canonical
   * state already contains the settled Turn.
   */
  replayAcceptedLiveCompletion?: true;
  turn: AgentActivityTurn;
}

/**
 * One authoritative realtime Turn projection. The Turn and the Session's
 * active-turn reference are one wire fact and must enter the Engine atomically.
 */
export interface TurnProjectionReceivedIntent {
  type: "turn/projectionReceived";
  activeTurnId: string | null;
  /**
   * The host has already fenced transport identity and ordering, so settlement
   * of this immutable Turn may absorb a temporary projection from another
   * version domain even when its wall-clock timestamp is lower.
   */
  hostFencedSameTurnSettlement?: true;
  turn: AgentActivityTurn;
  workspaceId: string;
}

export interface SessionHistoryAuthoritativeSnapshotReceivedIntent {
  type: "session/historyAuthoritativeSnapshotReceived";
  agentSessionId: string;
  childSessions: readonly AgentActivitySessionInput[];
  editRetry?: AgentActivityEditRetryAvailability;
  historyRevision: number;
  messages: readonly AgentActivityDurableMessage[];
  session: AgentActivitySessionInput;
  liveTurnId?: string;
  sessionMessageWindows?: readonly (AgentActivitySessionMessageWindow & {
    agentSessionId: string;
  })[];
  turns: readonly AgentActivityTurn[];
  workspaceId: string;
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

export interface SessionRestoredIntent {
  type: "session/restored";
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
  clientSubmitId?: string;
  timeoutMs?: number;
  workspaceId: string;
}

export interface SessionStopRequestedIntent {
  type: "session/stopRequested";
  agentSessionId: string;
  commandId: string;
  awaitingTurnExpiresAtUnixMs: number;
  clientSubmitId?: string;
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

export interface SessionSettingsPreconditionRequestedIntent {
  type: "session/settingsPreconditionRequested";
  agentSessionId: string;
  commandId: string;
  settings: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  workspaceId: string;
}

export interface SessionSettingsActivationRequestedIntent {
  type: "session/settingsActivationRequested";
  agentSessionId: string;
  commandId: string;
  settings: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  workspaceId: string;
}

export interface SessionSettingsQueueResumeRequestedIntent {
  type: "session/settingsQueueResumeRequested";
  agentSessionId: string;
  settingsCommandId: string;
}

export interface SessionRuntimeAvailabilityChangedIntent {
  type: "session/runtimeAvailabilityChanged";
  agentSessionId: string;
  availability: SessionRuntimeAvailability;
}

export interface SessionRuntimeActivityChangedIntent {
  type: "session/runtimeActivityChanged";
  agentSessionId: string;
  state: SessionRuntimeActivity;
  /** Zero clears the disconnected transport's transient observation and fence. */
  occurredAtUnixMs: number;
}

export type SessionLifecycleIntent =
  | InteractionUpsertedIntent
  | InteractionResponseRequestedIntent
  | SessionCancelAbandonedIntent
  | SessionCancelRequestedIntent
  | SessionErrorClearedIntent
  | SessionErrorRecordedIntent
  | SessionHistoryAuthoritativeSnapshotReceivedIntent
  | SessionMetadataPatchedIntent
  | SessionRemovedIntent
  | SessionRestoredIntent
  | SessionRuntimeActivityChangedIntent
  | SessionRuntimeAvailabilityChangedIntent
  | SessionSettingsActivationRequestedIntent
  | SessionSettingsPreconditionRequestedIntent
  | SessionSettingsQueueResumeRequestedIntent
  | SessionSettingsUpdateRequestedIntent
  | SessionSnapshotReceivedIntent
  | SessionStopRequestedIntent
  | SessionUpsertedIntent
  | TurnProjectionReceivedIntent
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
