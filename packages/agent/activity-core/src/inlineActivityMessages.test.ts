import assert from "node:assert/strict";
import test from "node:test";
import { parseInlineActivityMessages } from "./inlineActivityMessages.ts";
import type {
  AgentActivityEventTurn,
  AgentActivityTurn,
  AgentActivityUpdatedEvent
} from "./types.ts";

const completeTurnContract = {
  agentSessionId: "session-contract",
  capabilityRefs: [],
  completedCommand: null,
  error: null,
  fileChanges: null,
  origin: "goal_continuation",
  outcome: "completed",
  phase: "settled",
  settledAtUnixMs: 2,
  sourceGoalOperationId: "goal-operation-contract",
  sourceGoalRepairEpoch: 3,
  sourceGoalRevision: 4,
  startedAtUnixMs: 1,
  turnId: "turn-contract",
  updatedAtUnixMs: 2
} as const satisfies Required<AgentActivityTurn>;

const completeRealtimeTurnContract = {
  ...completeTurnContract,
  agentSessionId: "session-realtime-contract",
  turnId: "turn-realtime-contract"
} as const satisfies Required<AgentActivityEventTurn>;

test("canonical Turn contract is complete and exposes durable provenance", () => {
  assert.equal(completeTurnContract.origin, "goal_continuation");
  assert.equal(
    completeTurnContract.sourceGoalOperationId,
    "goal-operation-contract"
  );
  assert.equal(completeTurnContract.sourceGoalRevision, 4);
  assert.equal(completeTurnContract.sourceGoalRepairEpoch, 3);
  assert.equal(completeRealtimeTurnContract.origin, "goal_continuation");
  assert.equal(
    completeRealtimeTurnContract.sourceGoalOperationId,
    "goal-operation-contract"
  );
});

test("parses first-class session audit as a turnless transcript item", () => {
  const event: AgentActivityUpdatedEvent = {
    agentSessionId: "session-1",
    data: {
      agentSessionId: "session-1",
      eventType: "session_audit",
      audit: {
        auditId: "goal-control:op-1",
        occurredAtUnixMs: 20,
        payload: { text: "/goal clear" },
        role: "user",
        version: 2
      },
      workspaceId: "workspace-1"
    },
    eventType: "session_audit",
    workspaceId: "workspace-1"
  };

  const messages = parseInlineActivityMessages(event);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.turnId, null);
  assert.equal(messages[0]?.kind, "session_audit");
  assert.deepEqual(messages[0]?.payload, { text: "/goal clear" });
});

test("rejects nullable turn id on ordinary realtime messages", () => {
  const event = {
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
          sequence: 7,
          occurredAtUnixMs: 20,
          createdAtUnixMs: 10,
          payload: {},
          role: "assistant",
          turnId: null,
          version: 2
        }
      ],
      workspaceId: "workspace-1"
    },
    eventType: "message_update",
    workspaceId: "workspace-1"
  } as unknown as AgentActivityUpdatedEvent;
  assert.deepEqual(parseInlineActivityMessages(event), []);
});

test("preserves durable ordering fields on turn-scoped realtime messages", () => {
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
          createdAtUnixMs: 10,
          kind: "text",
          messageId: "message-1",
          occurredAtUnixMs: 20,
          payload: { text: "history" },
          role: "assistant",
          sequence: 7,
          turnId: "turn-1",
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
  assert.equal(messages[0]?.turnId, "turn-1");
  assert.equal(messages[0]?.sequence, 7);
  assert.equal(messages[0]?.createdAtUnixMs, 10);
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
        origin: "goal_continuation",
        phase: "settled",
        settledAtUnixMs: 20,
        sourceGoalOperationId: "goal-operation-1",
        sourceGoalRepairEpoch: 2,
        sourceGoalRevision: 3,
        startedAtUnixMs: 10,
        turnId: "turn-1",
        updatedAtUnixMs: 20
      },
      workspaceId: "workspace-1"
    },
    eventType: "turn_update",
    workspaceId: "workspace-1"
  };

  assert.equal(event.data.turn.origin, "goal_continuation");
  assert.equal(event.data.turn.sourceGoalOperationId, "goal-operation-1");
  assert.equal(event.data.turn.sourceGoalRevision, 3);
  assert.equal(event.data.turn.sourceGoalRepairEpoch, 2);
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
        origin: "user_prompt",
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
