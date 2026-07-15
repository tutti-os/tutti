export type SessionReconcileScope = "messages" | "state" | "state_and_messages";

export interface SessionReconcileRecord {
  agentSessionId: string;
  errorMessage: string | null;
  inFlightCommandId: string | null;
  inFlightScope: SessionReconcileScope | null;
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
