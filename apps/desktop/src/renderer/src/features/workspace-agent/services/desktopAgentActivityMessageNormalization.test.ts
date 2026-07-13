import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceAgentSessionMessage } from "@tutti-os/client-tuttid-ts";
import { normalizedTuttidMessageTurnId } from "./desktopAgentActivityMessageNormalization.ts";

test("preserves protocol v2 session-level message ownership", () => {
  const message = {
    agentSessionId: "session-1",
    messageId: "system-1",
    turnId: null,
    role: "assistant",
    kind: "text",
    occurredAtUnixMs: 1,
    version: 1
  } satisfies WorkspaceAgentSessionMessage;

  assert.equal(normalizedTuttidMessageTurnId(message), null);
});

test("normalizes non-empty turn ownership", () => {
  const message = {
    agentSessionId: "session-1",
    messageId: "message-1",
    turnId: "  turn-1  ",
    role: "assistant",
    kind: "text",
    occurredAtUnixMs: 1,
    version: 1
  } satisfies WorkspaceAgentSessionMessage;

  assert.equal(normalizedTuttidMessageTurnId(message), "turn-1");
});
