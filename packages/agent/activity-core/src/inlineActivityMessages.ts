import {
  cloneJSONValue,
  messageVersionValue,
  nullableStringValue,
  numberValue,
  recordValue,
  stringValue
} from "./activityValueParsing.ts";
import type {
  AgentActivityMessage,
  AgentActivityUpdatedEvent
} from "./types.ts";

/**
 * Parse the inline `messages` array carried by a realtime `message_update`
 * event into canonical {@link AgentActivityMessage} values. This is the only
 * inline delta the bridge applies without a follow-up pull: messages are
 * append-only and self-describing, so the engine's message reducer can fold
 * them (including alias-bucket collapse) on its own. Turn and interaction
 * deltas take the authoritative reconcile path instead, so their session-level
 * effects (activeTurnId, pending-interaction pruning) come from a full session
 * fetch rather than being reconstructed here.
 */
export function parseInlineActivityMessages(
  event: AgentActivityUpdatedEvent
): AgentActivityMessage[] {
  if (event.eventType !== "message_update") return [];
  const source = recordValue(event.data);
  const rawMessages = Array.isArray(source?.messages) ? source.messages : [];
  const eventAgentSessionId = event.agentSessionId.trim();
  const workspaceId = event.workspaceId?.trim() ?? "";
  const messages: AgentActivityMessage[] = [];
  for (const raw of rawMessages) {
    const record = recordValue(raw);
    if (!record) continue;
    const agentSessionId =
      stringValue(record.agentSessionId) || eventAgentSessionId;
    const message = agentActivityMessageFromInlineMessage({
      agentSessionId,
      message: record,
      workspaceId
    });
    if (message) messages.push(message);
  }
  return messages;
}

function agentActivityMessageFromInlineMessage(input: {
  agentSessionId: string;
  message: Record<string, unknown>;
  workspaceId: string;
}): AgentActivityMessage | null {
  const messageId = stringValue(input.message.messageId);
  const role = stringValue(input.message.role);
  const kind = stringValue(input.message.kind);
  const rawTurnId = input.message.turnId;
  const turnId = rawTurnId === null ? null : stringValue(rawTurnId);
  const version = messageVersionValue(input.message);
  const occurredAtUnixMs = numberValue(input.message.occurredAtUnixMs);
  if (
    !input.agentSessionId ||
    !messageId ||
    !role ||
    !kind ||
    (rawTurnId !== null && !turnId) ||
    version <= 0 ||
    occurredAtUnixMs === undefined ||
    occurredAtUnixMs <= 0
  ) {
    return null;
  }
  return {
    workspaceId: stringValue(input.message.workspaceId) || input.workspaceId,
    agentSessionId: input.agentSessionId,
    messageId,
    version,
    turnId,
    role,
    kind,
    status: nullableStringValue(input.message.status),
    semantics: recordValue(input.message.semantics)
      ? (cloneJSONValue(
          input.message.semantics
        ) as AgentActivityMessage["semantics"])
      : undefined,
    payload: cloneJSONValue(recordValue(input.message.payload) ?? {}) as Record<
      string,
      unknown
    >,
    occurredAtUnixMs,
    startedAtUnixMs: numberValue(input.message.startedAtUnixMs),
    completedAtUnixMs: numberValue(input.message.completedAtUnixMs)
  };
}
