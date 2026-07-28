export interface AgentActivityMessageSemantics {
  userVisibleAssistantResponse?: boolean;
  turnSettling?: boolean;
  noticeCommand?: "compact" | "review" | "undo" | "goal";
  noticeCommandStatus?: "running" | "completed" | "failed" | "canceled";
}

export interface AgentActivityMessageBase {
  workspaceId?: string;
  agentSessionId: string;
  messageId: string;
  version: number;
  turnId: string | null;
  role: string;
  kind: string;
  status?: string | null;
  semantics?: AgentActivityMessageSemantics;
  payload: Record<string, unknown>;
  occurredAtUnixMs: number;
  createdAtUnixMs?: number;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
}

export interface AgentActivityDurableMessage extends AgentActivityMessageBase {
  sequence: number;
}

export interface AgentActivityTransientMessage extends AgentActivityMessageBase {
  sequence?: undefined;
}

export type AgentActivityMessage =
  | AgentActivityDurableMessage
  | AgentActivityTransientMessage;

export interface AgentActivityMessageDeltaEvent {
  workspaceId: string;
  agentSessionId: string;
  eventType: "message_delta";
  data: {
    workspaceId: string;
    agentSessionId: string;
    messageId: string;
    turnId: string;
    role: string;
    kind: string;
    occurredAtUnixMs: number;
    content?:
      | { operation: "append_text"; text: string }
      | { operation: "set"; value: unknown };
    toolOutput?:
      | { operation: "set"; text: string }
      | { operation: "append_text"; text: string; offsetBytes: number };
    payloadSet?: Readonly<Record<string, unknown>>;
    payloadUnset?: readonly string[];
    status?: string;
    semantics?: AgentActivityMessageSemantics;
    startedAtUnixMs?: number;
    completedAtUnixMs?: number;
  };
}
