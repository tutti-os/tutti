import assert from "node:assert/strict";
import test from "node:test";
import { createAgentActivitySnapshotProjector } from "./engine/agentActivitySnapshot.projector.ts";
import { createAgentSessionEngine } from "./engine/createAgentSessionEngine.ts";
import type { EngineExternalCommand } from "./engine/types.ts";
import { createAgentActivityWorkspaceEventCoordinator } from "./workspaceEventCoordinator.ts";

function createHarness() {
  const commands: EngineExternalCommand[] = [];
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 10 },
    commandPort: {
      execute(command) {
        commands.push(command);
        return Promise.resolve(undefined);
      },
      executePlanDecision(command) {
        commands.push(command);
        return Promise.reject(new Error("not used by coordinator tests"));
      }
    },
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler: {
      schedule(_delayMs, task) {
        task();
        return { cancel() {} };
      }
    }
  });
  const projectCanonical = createAgentActivitySnapshotProjector("workspace-1");
  const readCanonicalSnapshot = () => projectCanonical(engine.getSnapshot());
  const coordinator = createAgentActivityWorkspaceEventCoordinator({
    engine,
    readCanonicalSnapshot,
    workspaceId: "workspace-1"
  });
  return { commands, coordinator, engine, readCanonicalSnapshot };
}

test("projects message deltas and clears them on authoritative deletion", () => {
  const harness = createHarness();
  const applied = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      messageId: "message-1",
      turnId: "turn-1",
      role: "assistant",
      kind: "text",
      occurredAtUnixMs: 10,
      content: { operation: "set", value: "hello" }
    }
  });

  assert.equal(applied.accepted, true);
  assert.equal(applied.optimisticMessage?.payload.text, "hello");
  assert.equal(
    harness.coordinator.project(harness.readCanonicalSnapshot())
      .sessionMessagesById["session-1"]?.[0]?.payload.text,
    "hello"
  );

  const deleted = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "session_deleted",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "session_deleted",
      deletedAtUnixMs: 11
    }
  });

  assert.equal(deleted.reason, "deleted");
  assert.equal(harness.coordinator.isSessionDeleted("session-1"), true);
  assert.equal(
    harness.coordinator.project(harness.readCanonicalSnapshot())
      .sessionMessagesById["session-1"],
    undefined
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("authoritative history drops a terminal optimistic row from a retracted Turn", () => {
  const harness = createHarness();
  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      messageId: "retracted-message",
      turnId: "retracted-turn",
      role: "assistant",
      kind: "text",
      occurredAtUnixMs: 10,
      completedAtUnixMs: 11,
      status: "completed",
      content: { operation: "set", value: "old answer" }
    }
  });

  assert.equal(
    harness.coordinator.project(harness.readCanonicalSnapshot())
      .sessionMessagesById["session-1"]?.length,
    1
  );

  harness.coordinator.reconcileAuthoritativeHistory("session-1", [], []);

  assert.equal(
    harness.coordinator.project(harness.readCanonicalSnapshot())
      .sessionMessagesById["session-1"]?.length,
    0
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("preserves unrelated Session message projections during an optimistic delta", () => {
  const harness = createHarness();
  harness.engine.dispatch({
    messages: [
      message("session-a", "message-a", "canonical a"),
      message("session-b", "message-b", "canonical b")
    ],
    type: "message/snapshotReceived",
    workspaceId: "workspace-1"
  });
  const before = harness.coordinator.project(harness.readCanonicalSnapshot());

  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-a",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-a",
      messageId: "message-a",
      turnId: "turn-1",
      role: "assistant",
      kind: "text",
      occurredAtUnixMs: 10,
      content: { operation: "set", value: "canonical a live" }
    }
  });

  const after = harness.coordinator.project(harness.readCanonicalSnapshot());
  assert.notEqual(
    after.sessionMessagesById["session-a"],
    before.sessionMessagesById["session-a"]
  );
  assert.equal(
    after.sessionMessagesById["session-a"]?.[0]?.payload.text,
    "canonical a live"
  );
  assert.equal(
    after.sessionMessagesById["session-b"],
    before.sessionMessagesById["session-b"]
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("reconnect hydrates the workspace, priority session, and cached messages", () => {
  const harness = createHarness();
  harness.engine.dispatch({
    messages: [
      {
        workspaceId: "workspace-1",
        agentSessionId: "session-cached",
        messageId: "message-1",
        version: 1,
        sequence: 1,
        turnId: "turn-1",
        role: "assistant",
        kind: "text",
        payload: { text: "cached" },
        occurredAtUnixMs: 1
      }
    ],
    type: "message/snapshotReceived",
    workspaceId: "workspace-1"
  });
  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-overlay-only",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-overlay-only",
      messageId: "message-overlay",
      turnId: "turn-overlay",
      role: "assistant",
      kind: "text",
      occurredAtUnixMs: 2,
      content: { operation: "set", value: "optimistic" }
    }
  });

  harness.coordinator.eventStreamConnectionChanged({
    status: "connected",
    prioritySessionIds: ["session-selected"]
  });
  harness.coordinator.eventStreamConnectionChanged({
    status: "disconnected"
  });
  harness.coordinator.eventStreamConnectionChanged({
    status: "connected",
    prioritySessionIds: ["session-selected"]
  });

  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "engine/reconcileWorkspace" &&
        command.workspaceId === "workspace-1"
    )
  );
  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-selected" &&
        command.scope === "state_and_messages"
    )
  );
  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-cached" &&
        command.scope === "state_and_messages"
    )
  );
  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-overlay-only" &&
        command.scope === "state_and_messages"
    )
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("settled turn updates request a combined reconcile even without inline messages", () => {
  const harness = createHarness();

  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "turn_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "turn_update",
      occurredAtUnixMs: 10,
      activeTurnId: null,
      turn: {
        agentSessionId: "session-1",
        completedCommand: null,
        error: null,
        fileChanges: null,
        origin: "user_prompt",
        outcome: "completed",
        phase: "settled",
        startedAtUnixMs: 1,
        settledAtUnixMs: 10,
        turnId: "turn-1",
        updatedAtUnixMs: 10
      }
    }
  });

  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-1" &&
        command.scope === "state_and_messages"
    )
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});
function message(agentSessionId: string, messageId: string, text: string) {
  return {
    workspaceId: "workspace-1",
    agentSessionId,
    messageId,
    version: 1,
    sequence: 1,
    turnId: "turn-1",
    role: "assistant" as const,
    kind: "text",
    payload: { text },
    occurredAtUnixMs: 1
  };
}

test("invalid wire delta stays inside the coordinator and requests reconcile", () => {
  const harness = createHarness();
  const result = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      content: { operation: "append_text" }
    }
  });

  assert.equal(result.reason, "invalid_delta");
  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-1"
    )
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("mismatched deletion identity reconciles instead of tombstoning", () => {
  const harness = createHarness();
  const result = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "session_deleted",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-other",
      eventType: "session_deleted",
      deletedAtUnixMs: 11
    }
  });

  assert.equal(result.reason, "identity_mismatch");
  assert.equal(harness.coordinator.isSessionDeleted("session-1"), false);
  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-1"
    )
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});
