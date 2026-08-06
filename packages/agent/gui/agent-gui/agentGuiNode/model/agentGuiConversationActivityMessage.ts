import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";

export function resolveAgentGUIConversationActivityMessage(
  messages: readonly AgentActivityMessage[]
): string | null {
  const candidates = messages
    .filter((message) => {
      const role = message.role.trim().toLowerCase();
      return (
        (role === "assistant" || role === "agent") &&
        message.semantics?.userVisibleAssistantResponse !== false
      );
    })
    .map((message) => ({
      message,
      text: activityMessageText(message)
    }))
    .filter((candidate) => candidate.text.length > 0)
    .sort(
      (left, right) =>
        right.message.occurredAtUnixMs - left.message.occurredAtUnixMs ||
        (right.message.sequence ?? 0) - (left.message.sequence ?? 0) ||
        right.message.messageId.localeCompare(left.message.messageId)
    );
  return candidates[0]?.text ?? null;
}

function activityMessageText(message: AgentActivityMessage): string {
  if (message.kind.trim().toLowerCase() === "tool_call") return "";
  const payload = message.payload;
  for (const value of [
    payload.text,
    payload.content,
    payload.message,
    payload.body,
    payload.title
  ]) {
    const text = activityMessageValueText(value);
    if (text) return text;
  }
  return "";
}

function activityMessageValueText(value: unknown): string {
  if (typeof value === "string") return compactActivityMessageText(value);
  if (!Array.isArray(value)) return "";
  return compactActivityMessageText(
    value
      .flatMap((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          return [];
        }
        const record = block as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string"
          ? [record.text]
          : [];
      })
      .join(" ")
  );
}

function compactActivityMessageText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
