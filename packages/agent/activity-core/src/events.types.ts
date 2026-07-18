import type {
  AgentActivityCapabilityReference,
  AgentActivityInteraction,
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivityTurnOrigin,
  AgentActivityTurnOutcome,
  AgentActivityTurnPhase
} from "./types.ts";

export type AgentActivityUpdatedEvent =
  | AgentActivitySessionReconcileRequiredEvent
  | AgentActivitySessionDeletedEvent
  | AgentActivitySessionAuditEvent
  | AgentActivityMessageUpdatedEvent
  | AgentActivityTurnUpdatedEvent
  | AgentActivityInteractionUpdatedEvent;

export interface AgentActivitySessionReconcileRequiredEvent {
  workspaceId: string;
  agentSessionId: string;
  eventType: "session_reconcile_required";
  data: {
    workspaceId: string;
    agentSessionId: string;
    agentTargetId?: string;
    eventType: "session_reconcile_required";
    lastEventUnixMs: number;
  };
}

export interface AgentActivitySessionDeletedEvent {
  workspaceId: string;
  agentSessionId: string;
  eventType: "session_deleted";
  data: {
    workspaceId: string;
    agentSessionId: string;
    eventType: "session_deleted";
    deletedAtUnixMs: number;
  };
}

export interface AgentActivityMessageUpdatedEvent {
  workspaceId: string;
  agentSessionId: string;
  eventType: "message_update";
  data: {
    workspaceId: string;
    agentSessionId: string;
    eventType: "message_update";
    latestVersion: number;
    acceptedCount: number;
    messages: readonly AgentActivityEventMessage[];
  };
}

export interface AgentActivitySessionAuditEvent {
  workspaceId: string;
  agentSessionId: string;
  eventType: "session_audit";
  data: {
    workspaceId: string;
    agentSessionId: string;
    eventType: "session_audit";
    audit: {
      auditId: string;
      role: string;
      payload: Record<string, unknown>;
      occurredAtUnixMs: number;
      version: number;
    };
  };
}

export interface AgentActivityEventMessage {
  agentSessionId: string;
  kind: string;
  messageId: string;
  payload: Record<string, unknown>;
  role: string;
  version: number;
  turnId: string | null;
  status?: string;
  sequence?: number;
  occurredAtUnixMs: number;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
  createdAtUnixMs?: number;
  updatedAtUnixMs?: number;
}

export interface AgentActivityTurnUpdatedEvent {
  workspaceId: string;
  agentSessionId: string;
  eventType: "turn_update";
  data: {
    workspaceId: string;
    agentSessionId: string;
    eventType: "turn_update";
    occurredAtUnixMs: number;
    activeTurnId: string | null;
    turn: AgentActivityEventTurn;
  };
}

export interface AgentActivityEventTurn {
  turnId: string;
  agentSessionId: string;
  capabilityRefs?: readonly AgentActivityCapabilityReference[];
  phase: AgentActivityTurnPhase;
  origin: AgentActivityTurnOrigin;
  sourceGoalOperationId?: string | null;
  sourceGoalRevision?: number | null;
  sourceGoalRepairEpoch?: number | null;
  outcome: AgentActivityTurnOutcome | null;
  error: Record<string, unknown> | null;
  fileChanges: unknown;
  completedCommand: Record<string, unknown> | null;
  startedAtUnixMs: number;
  settledAtUnixMs: number | null;
  updatedAtUnixMs: number;
}

export interface AgentActivityInteractionUpdatedEvent {
  workspaceId: string;
  agentSessionId: string;
  eventType: "interaction_update";
  data: {
    workspaceId: string;
    agentSessionId: string;
    eventType: "interaction_update";
    occurredAtUnixMs: number;
    interaction: AgentActivityInteraction;
  };
}

export type AgentActivitySessionEventEnvelope = Extract<
  AgentActivityUpdatedEvent,
  { eventType: "message_update" | "session_audit" }
>;

export interface AgentActivityUpdatedApplyResult {
  applied: boolean;
  messages: AgentActivityMessage[];
  session: AgentActivitySession | null;
}
