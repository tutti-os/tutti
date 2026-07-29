import type {
  AgentActivityMessage,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import { normalizeTuttidError } from "@tutti-os/client-tuttid-ts";

export function agentActivitySessionReconcileDiagnosticDetails(
  session: AgentActivitySession | null
): Record<string, unknown> | null {
  if (!session) return null;
  return {
    activeTurnId: session.activeTurnId ?? null,
    agentSessionId: session.agentSessionId,
    lastEventUnixMs: session.lastEventUnixMs ?? null,
    messageVersion: session.messageVersion ?? null,
    outcome: session.activeTurn?.outcome ?? null,
    provider: session.provider,
    turnPhase: session.activeTurn?.phase ?? null,
    updatedAtUnixMs: session.updatedAtUnixMs ?? null
  };
}

export function normalizeWorkspaceId(workspaceId: string): string {
  return workspaceId.trim() || "__default__";
}

export function isTerminalTurnUpdate(input: {
  data: unknown;
  eventType: string;
}): boolean {
  if (input.eventType !== "turn_update") return false;
  const data =
    input.data && typeof input.data === "object"
      ? (input.data as Record<string, unknown>)
      : null;
  const turn =
    data?.turn && typeof data.turn === "object"
      ? (data.turn as Record<string, unknown>)
      : null;
  return turn?.phase === "settled";
}

export function isWorkspaceAgentSessionNotFoundError(error: unknown): boolean {
  const normalized = normalizeTuttidError(error);
  return (
    normalized?.code === "workspace_not_found" &&
    normalized.reason === "workspace_agent_session_not_found"
  );
}

export function hasInlineMessagesData(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { messages?: unknown }).messages)
  );
}

export function hostMessageEventFromCore(
  message: AgentActivityMessage
): unknown {
  return {
    data: {
      agentSessionId: message.agentSessionId,
      completedAtUnixMs: message.completedAtUnixMs,
      kind: message.kind,
      messageId: message.messageId,
      occurredAtUnixMs: message.occurredAtUnixMs,
      payload: message.payload,
      role: message.role,
      seq: message.version,
      version: message.version,
      startedAtUnixMs: message.startedAtUnixMs,
      status: message.status ?? undefined,
      turnId: message.turnId,
      workspaceId: message.workspaceId
    },
    eventType: "message_update"
  };
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
