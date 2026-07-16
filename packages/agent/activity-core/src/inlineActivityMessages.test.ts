import assert from "node:assert/strict";
import test from "node:test";
import { parseInlineActivityMessages } from "./inlineActivityMessages.ts";
import type { AgentActivityUpdatedEvent } from "./types.ts";

test("parses normalized realtime messages including a nullable turn id", () => {
  const event: AgentActivityUpdatedEvent = {
    agentSessionId: "session-1",
    data: {
      acceptedCount: 1,
      agentSessionId: "session-1",
      eventType: "message_update",
      latestVersion: 2,
      messages: [
        {
          agentSessionId: "session-1",
          kind: "text",
          messageId: "message-1",
          occurredAtUnixMs: 20,
          payload: { text: "history" },
          role: "assistant",
          turnId: null,
          version: 2
        }
      ],
      workspaceId: "workspace-1"
    },
    eventType: "message_update",
    workspaceId: "workspace-1"
  };

  const messages = parseInlineActivityMessages(event);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.turnId, null);
  assert.deepEqual(messages[0]?.payload, { text: "history" });
});

test("does not inline turn or interaction updates", () => {
  const event: AgentActivityUpdatedEvent = {
    agentSessionId: "session-1",
    data: {
      activeTurnId: null,
      agentSessionId: "session-1",
      eventType: "turn_update",
      occurredAtUnixMs: 20,
      turn: {
        agentSessionId: "session-1",
        capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
        completedCommand: null,
        error: null,
        fileChanges: null,
        outcome: "completed",
        phase: "settled",
        settledAtUnixMs: 20,
        startedAtUnixMs: 10,
        turnId: "turn-1",
        updatedAtUnixMs: 20
      },
      workspaceId: "workspace-1"
    },
    eventType: "turn_update",
    workspaceId: "workspace-1"
  };

  assert.deepEqual(parseInlineActivityMessages(event), []);
});

test("accepts live turn events with nullable outcome and capability provenance", () => {
  const event: AgentActivityUpdatedEvent = {
    agentSessionId: "session-1",
    data: {
      activeTurnId: "turn-1",
      agentSessionId: "session-1",
      eventType: "turn_update",
      occurredAtUnixMs: 20,
      turn: {
        agentSessionId: "session-1",
        capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
        completedCommand: null,
        error: null,
        fileChanges: null,
        outcome: null,
        phase: "running",
        settledAtUnixMs: null,
        startedAtUnixMs: 10,
        turnId: "turn-1",
        updatedAtUnixMs: 20
      },
      workspaceId: "workspace-1"
    },
    eventType: "turn_update",
    workspaceId: "workspace-1"
  };

  assert.deepEqual(parseInlineActivityMessages(event), []);
});
