import type {
  AgentActivityDurableMessage,
  AgentActivitySession,
  AgentActivityTurn
} from "../types.ts";
import type { AgentActivitySessionMessageWindow } from "../messageWindow.types.ts";
import type { AgentActivitySessionInput } from "../sessionNormalization.ts";
import type { AgentActivityEditRetryAvailability } from "./editRetry.types.ts";

export type SessionReconcileScope = "messages" | "state" | "state_and_messages";

/**
 * Host-neutral projection-qualified detail aggregate consumed by reconcile
 * flows. Transport adapters preserve projection authority so Core can use an
 * unprojected discovery snapshot for cursors without applying its capability
 * values as canonical state.
 */
export interface AgentActivitySessionDetailSnapshot {
  projection: "authoritative" | "message_hydration";
  lifecycleCapabilitiesProjected: boolean;
  session: AgentActivitySession;
  childSessions: readonly AgentActivitySession[];
  editRetry?: AgentActivityEditRetryAvailability;
  turns: readonly AgentActivityTurn[];
}

export interface SessionReconcileRecord {
  agentSessionId: string;
  errorCode: string | null;
  errorMessage: string | null;
  inFlightCommandId: string | null;
  inFlightLive: boolean;
  inFlightScope: SessionReconcileScope | null;
  messagesHydrated: boolean;
  pendingLive: boolean;
  pendingMessages: boolean;
  pendingState: boolean;
  workspaceId: string;
}

export interface SessionReconcileState {
  nextCommandSequence: number;
  recordsBySessionId: Readonly<Record<string, SessionReconcileRecord>>;
}

export interface SessionReconcileRequestedIntent {
  type: "session/reconcileRequested";
  agentSessionId: string;
  live?: boolean;
  needsMessages: boolean;
  needsState: boolean;
  workspaceId: string;
}

export interface SessionActivityObservedIntent {
  type: "session/activityObserved";
  agentSessionId: string;
  eventType: string;
  hasCachedSession: boolean;
  hasInlineMessages: boolean;
  inlineApplied: boolean;
  terminalTurn?: boolean;
  workspaceId: string;
}

export interface SessionDetailSnapshotReceivedIntent {
  type: "session/detailSnapshotReceived";
  childSessions: readonly AgentActivitySessionInput[];
  editRetry?: AgentActivityEditRetryAvailability;
  live?: boolean;
  messages?: readonly AgentActivityDurableMessage[];
  session: AgentActivitySessionInput;
  sessionMessageWindows?: readonly (AgentActivitySessionMessageWindow & {
    agentSessionId: string;
  })[];
  turns: readonly AgentActivityTurn[];
  workspaceId: string;
}

export type SessionReconcileIntent =
  | SessionActivityObservedIntent
  | SessionDetailSnapshotReceivedIntent
  | SessionReconcileRequestedIntent;

export interface SessionReconcileCommand {
  type: "session/reconcile";
  agentSessionId: string;
  commandId: string;
  live: boolean;
  scope: SessionReconcileScope;
  timeoutMs?: number;
  workspaceId: string;
}
