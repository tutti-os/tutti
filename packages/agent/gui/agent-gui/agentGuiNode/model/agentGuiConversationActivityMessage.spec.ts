import { expect, test } from "vitest";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { resolveAgentGUIConversationActivityMessage } from "./agentGuiConversationActivityMessage.ts";

test("activity message selects the latest in-memory agent text without hydration", () => {
  expect(
    resolveAgentGUIConversationActivityMessage([
      message("user", "new user prompt", 30),
      message("assistant", "older answer", 10),
      message("agent", "latest\nanswer", 20)
    ])
  ).toBe("latest answer");
});

test("activity message ignores tool calls and empty agent payloads", () => {
  expect(
    resolveAgentGUIConversationActivityMessage([
      message("assistant", "tool details", 20, "tool_call"),
      message("assistant", "", 30)
    ])
  ).toBeNull();
});

test("activity message ignores explicitly non-user-visible assistant output", () => {
  const hidden = message("assistant", "internal settling output", 30);
  hidden.semantics = { userVisibleAssistantResponse: false };

  expect(resolveAgentGUIConversationActivityMessage([hidden])).toBeNull();
});

test("activity message compacts provider text content blocks", () => {
  const candidate = message("assistant", "", 30);
  candidate.payload.content = [
    { type: "text", text: "First line" },
    { type: "image", url: "ignored" },
    { type: "text", text: "second\nline" }
  ];

  expect(resolveAgentGUIConversationActivityMessage([candidate])).toBe(
    "First line second line"
  );
});

function message(
  role: string,
  text: string,
  occurredAtUnixMs: number,
  kind = "text"
): AgentActivityMessage {
  return {
    agentSessionId: "session-1",
    kind,
    messageId: `${role}-${occurredAtUnixMs}`,
    occurredAtUnixMs,
    payload: { text },
    role,
    sequence: occurredAtUnixMs,
    turnId: "turn-1",
    version: occurredAtUnixMs
  };
}
