import type {
  AgentActivityInteractionUpdatedEvent,
  AgentActivityMessageSemantics,
  AgentActivitySessionAuditEvent,
  AgentActivityTurnUpdatedEvent
} from "./types.ts";

export type AgentActivityLiveEvent =
  | AgentActivityMessageDeltaEvent
  | AgentActivityTurnUpdatedEvent
  | AgentActivityInteractionUpdatedEvent
  | AgentActivitySessionAuditEvent;

export interface AgentActivityMessageDeltaEvent {
  workspaceId: string;
  agentSessionId: string;
  eventType: "message_delta";
  data: {
    workspaceId: string;
    agentSessionId: string;
    messageId: string;
    turnId?: string;
    role: string;
    kind: string;
    occurredAtUnixMs: number;
    content?:
      | { operation: "append_text"; text: string }
      | { operation: "set"; value: unknown };
    payloadSet?: Readonly<Record<string, unknown>>;
    payloadUnset?: readonly string[];
    status?: string;
    semantics?: AgentActivityMessageSemantics;
    startedAtUnixMs?: number;
    completedAtUnixMs?: number;
  };
}
