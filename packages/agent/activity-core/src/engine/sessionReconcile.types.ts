import type {
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivityTurn
} from "../types.ts";
import type { SessionDeletionEvidence } from "./sessionDeletion.types.ts";

export type SessionReconcileScope = "messages" | "state" | "state_and_messages";

/**
 * Typed transport outcome for `session/reconcile`. Bare HTTP 404 must normalize
 * to `absent`; only explicit deletion evidence may use `deleted`.
 */
export type SessionReconcileResult =
  | {
      kind: "found";
      session: AgentActivitySession;
      childSessions?: readonly AgentActivitySession[];
      turns?: readonly AgentActivityTurn[];
      messages?: readonly AgentActivityMessage[];
      /** When true, settled turns may light realtime attention. */
      live?: boolean;
    }
  | { kind: "absent" }
  | { kind: "deleted"; evidence: SessionDeletionEvidence };

export interface SessionReconcileRecord {
  agentSessionId: string;
  errorMessage: string | null;
  inFlightCommandId: string | null;
  inFlightScope: SessionReconcileScope | null;
  /** Soft observation that the last settle saw transport absence. */
  lastAbsent: boolean;
  messagesHydrated: boolean;
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

export type SessionReconcileIntent =
  | SessionActivityObservedIntent
  | SessionReconcileRequestedIntent;

export interface SessionReconcileCommand {
  type: "session/reconcile";
  agentSessionId: string;
  commandId: string;
  scope: SessionReconcileScope;
  timeoutMs?: number;
  workspaceId: string;
}
