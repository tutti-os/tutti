import type {
  AgentActivityDurableMessage,
  AgentActivitySession,
  AgentActivityTurn
} from "../types.ts";
import type { AgentActivitySessionMessageWindow } from "../messageWindow.types.ts";
import type { AgentActivitySessionInput } from "../sessionNormalization.ts";

export type SessionReconcileScope = "messages" | "state" | "state_and_messages";

/**
 * Host-neutral authoritative detail aggregate consumed by reconcile flows.
 * Transport adapters map their DTOs into this contract before Core sees them.
 */
export interface AgentActivitySessionDetailSnapshot {
  session: AgentActivitySession;
  childSessions: readonly AgentActivitySession[];
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
  workspaceId: string;
}

export interface SessionDetailSnapshotReceivedIntent {
  type: "session/detailSnapshotReceived";
  childSessions: readonly AgentActivitySessionInput[];
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
