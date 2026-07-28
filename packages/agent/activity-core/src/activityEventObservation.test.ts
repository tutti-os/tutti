import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityMessage,
  AgentActivityUpdatedEvent
} from "./types.ts";
import {
  analyzeAgentActivityEventObservation,
  analyzeInlineMessageVersionContinuity
} from "./activityEventObservation.ts";

test("inline continuity accepts an extension after the latest cached cursor", () => {
  assert.deepEqual(
    analyzeInlineMessageVersionContinuity(
      [message(1), message(5)],
      [message(6), message(7)]
    ),
    {
      cachedVersion: 5,
      continuous: true,
      firstUnseenVersion: 6,
      latestIncomingVersion: 7
    }
  );
});

test("inline continuity rejects an unseen mutable version hole", () => {
  assert.equal(
    analyzeInlineMessageVersionContinuity([message(1)], [message(3)])
      .continuous,
    false
  );
});

test("message updates apply inline only for a cached Session with continuity", () => {
  const event = messageUpdateEvent([eventMessage(2)]);
  const cached = analyzeAgentActivityEventObservation({
    cachedMessages: [message(1)],
    event,
    hasCachedSession: true
  });
  const uncached = analyzeAgentActivityEventObservation({
    cachedMessages: [],
    event: messageUpdateEvent([eventMessage(1)]),
    hasCachedSession: false
  });

  assert.equal(cached.canApplyInlineMessages, true);
  assert.equal(cached.intent.inlineApplied, true);
  assert.equal(cached.intent.hasInlineMessages, true);
  assert.equal(uncached.canApplyInlineMessages, true);
  assert.equal(uncached.intent.inlineApplied, false);
});

test("message updates fail closed when any advertised message is malformed", () => {
  const malformed = {
    ...eventMessage(3),
    occurredAtUnixMs: 0
  };
  const observation = analyzeAgentActivityEventObservation({
    cachedMessages: [message(1)],
    event: messageUpdateEvent([eventMessage(2), malformed]),
    hasCachedSession: true
  });

  assert.deepEqual(
    observation.inlineMessages.map((item) => item.version),
    [2]
  );
  assert.equal(observation.canApplyInlineMessages, false);
  assert.equal(observation.intent.inlineApplied, false);
});

test("message updates fail closed on envelope, message, or cursor disagreement", () => {
  const mismatchedData = messageUpdateEvent([eventMessage(2)]);
  mismatchedData.data.agentSessionId = "session-2";
  const mismatchedMessage = messageUpdateEvent([
    { ...eventMessage(2), agentSessionId: "session-2" }
  ]);
  const mismatchedCursor = messageUpdateEvent([eventMessage(2)]);
  mismatchedCursor.data.latestVersion = 3;

  for (const event of [mismatchedData, mismatchedMessage, mismatchedCursor]) {
    const observation = analyzeAgentActivityEventObservation({
      cachedMessages: [message(1)],
      event,
      hasCachedSession: true
    });
    assert.equal(observation.canApplyInlineMessages, false);
    assert.equal(observation.intent.inlineApplied, false);
  }
});

test("message updates fail closed when acceptedCount disagrees with the payload", () => {
  const event = messageUpdateEvent([eventMessage(2)]);
  event.data.acceptedCount = 2;

  const observation = analyzeAgentActivityEventObservation({
    cachedMessages: [message(1)],
    event,
    hasCachedSession: true
  });

  assert.equal(observation.canApplyInlineMessages, false);
  assert.equal(observation.intent.inlineApplied, false);
});

test("turn and interaction observations require canonical state reconciliation", () => {
  const event: Extract<
    AgentActivityUpdatedEvent,
    { eventType: "session_reconcile_required" }
  > = {
    agentSessionId: "session-1",
    data: {
      agentSessionId: "session-1",
      agentTargetId: "target-1",
      eventType: "session_reconcile_required",
      lastEventUnixMs: 10,
      workspaceId: "workspace-1"
    },
    eventType: "session_reconcile_required",
    workspaceId: "workspace-1"
  };

  const observation = analyzeAgentActivityEventObservation({
    cachedMessages: [],
    event,
    hasCachedSession: true
  });

  assert.deepEqual(observation.inlineMessages, []);
  assert.deepEqual(observation.intent, {
    agentSessionId: "session-1",
    eventType: "session_reconcile_required",
    hasCachedSession: true,
    hasInlineMessages: false,
    inlineApplied: false,
    type: "session/activityObserved",
    workspaceId: "workspace-1"
  });
});

function message(version: number): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    kind: "text",
    messageId: `message-${version}`,
    occurredAtUnixMs: version,
    payload: { text: String(version) },
    role: "assistant",
    turnId: "turn-1",
    version
  };
}

function eventMessage(version: number) {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId: `message-${version}`,
    occurredAtUnixMs: version,
    payload: { text: String(version) },
    role: "assistant",
    sequence: version,
    turnId: "turn-1",
    version
  };
}

function messageUpdateEvent(
  messages: ReturnType<typeof eventMessage>[]
): Extract<AgentActivityUpdatedEvent, { eventType: "message_update" }> {
  return {
    agentSessionId: "session-1",
    data: {
      acceptedCount: messages.length,
      agentSessionId: "session-1",
      eventType: "message_update",
      latestVersion: messages.at(-1)?.version ?? 0,
      messages,
      workspaceId: "workspace-1"
    },
    eventType: "message_update",
    workspaceId: "workspace-1"
  };
}
