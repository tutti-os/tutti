import assert from "node:assert/strict";
import test from "node:test";
import { createAgentActivitySnapshotProjector } from "./engine/agentActivitySnapshot.projector.ts";
import { createAgentSessionEngine } from "./engine/createAgentSessionEngine.ts";
import { canonicalTurnKey } from "./engine/sessionEntityKeys.ts";
import {
  selectEngineSessionRuntimeActivity,
  selectWorkspaceAgentConsumerSession
} from "./engine/sessionLifecycle.selectors.ts";
import { createTestEngineCommandPort } from "./engine/testEngineCommandPort.ts";
import type { EngineExternalCommand } from "./engine/types.ts";
import { normalizeAgentActivitySession } from "./sessionNormalization.ts";
import type {
  AgentActivityUpdatedEvent,
  AgentActivityTurn,
  AgentActivityTurnUpdatedEvent
} from "./types.ts";
import { createAgentActivityWorkspaceEventCoordinator } from "./workspaceEventCoordinator.ts";

function createHarness() {
  const commands: EngineExternalCommand[] = [];
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 10 },
    commandPort: createTestEngineCommandPort((command) => {
      commands.push(command);
      return Promise.resolve(undefined);
    }),
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

test("projects provider runtime activity before a canonical Turn and clears it on disconnect", () => {
  const harness = createHarness();
  const running = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "runtime_activity_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "runtime_activity_update",
      state: "running",
      occurredAtUnixMs: 10
    }
  });

  assert.equal(running.accepted, true);
  assert.equal(
    selectEngineSessionRuntimeActivity(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    "running"
  );

  harness.engine.dispatch({
    session: session(null, 10),
    type: "session/upserted"
  });
  assert.equal(
    selectWorkspaceAgentConsumerSession(
      harness.engine.getSnapshot(),
      "session-1"
    )?.displayStatus,
    "working"
  );

  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "runtime_activity_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "runtime_activity_update",
      state: "idle",
      occurredAtUnixMs: 11
    }
  });
  assert.equal(
    selectWorkspaceAgentConsumerSession(
      harness.engine.getSnapshot(),
      "session-1"
    )?.displayStatus,
    "idle"
  );

  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "runtime_activity_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "runtime_activity_update",
      state: "running",
      occurredAtUnixMs: 12
    }
  });

  harness.coordinator.eventStreamConnectionChanged({ status: "disconnected" });
  assert.equal(
    selectEngineSessionRuntimeActivity(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    "idle"
  );

  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("rejects stale and tombstoned runtime activity observations", () => {
  const harness = createHarness();
  harness.engine.dispatch({
    session: session(null, 10),
    type: "session/upserted"
  });
  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "runtime_activity_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "runtime_activity_update",
      state: "idle",
      occurredAtUnixMs: 12
    }
  });

  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "runtime_activity_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "runtime_activity_update",
      state: "running",
      occurredAtUnixMs: 11
    }
  });
  assert.equal(
    selectEngineSessionRuntimeActivity(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    "idle"
  );

  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "session_deleted",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "session_deleted",
      deletedAtUnixMs: 13
    }
  });
  const tombstoned = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "runtime_activity_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "runtime_activity_update",
      state: "running",
      occurredAtUnixMs: 14
    }
  });
  assert.equal(tombstoned.reason, "tombstoned");
  assert.equal(
    harness.engine.getSnapshot().sessionLifecycle.operationBySessionId[
      "session-1"
    ],
    undefined
  );

  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("rejects runtime activity whose data identity does not match the envelope", () => {
  const harness = createHarness();
  const result = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "runtime_activity_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-other",
      eventType: "runtime_activity_update",
      state: "running",
      occurredAtUnixMs: 10
    }
  });

  assert.equal(result.reason, "identity_mismatch");
  assert.equal(
    harness.engine.getSnapshot().sessionLifecycle.operationBySessionId[
      "session-1"
    ],
    undefined
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("a stale running observation cannot override a settled canonical Turn", () => {
  const harness = createHarness();
  harness.engine.dispatch({
    session: session(turn("settled", 20), 20),
    type: "session/upserted"
  });
  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "runtime_activity_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "runtime_activity_update",
      state: "running",
      occurredAtUnixMs: 19
    }
  });

  assert.equal(
    selectWorkspaceAgentConsumerSession(
      harness.engine.getSnapshot(),
      "session-1"
    )?.displayStatus,
    "completed"
  );

  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "runtime_activity_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "runtime_activity_update",
      state: "running",
      occurredAtUnixMs: 21
    }
  });
  assert.equal(
    selectWorkspaceAgentConsumerSession(
      harness.engine.getSnapshot(),
      "session-1"
    )?.displayStatus,
    "working"
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});

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

test("keeps a reasoning append anchor across an unrelated inline canonical update", () => {
  const harness = createHarness();
  harness.engine.dispatch({
    session: session(turn("running", 1), 1),
    type: "session/upserted"
  });
  harness.engine.dispatch({
    messages: [message("session-1", "message-1", "canonical")],
    type: "message/snapshotReceived",
    workspaceId: "workspace-1"
  });

  harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      messageId: "reasoning-live",
      turnId: "turn-1",
      role: "assistant",
      kind: "reasoning",
      occurredAtUnixMs: 2,
      content: { operation: "set", value: "正在" }
    }
  });

  const inline = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "message_update",
      latestVersion: 2,
      acceptedCount: 1,
      messages: [
        {
          agentSessionId: "session-1",
          kind: "text",
          messageId: "message-2",
          occurredAtUnixMs: 3,
          payload: { text: "其他消息" },
          role: "assistant",
          sequence: 2,
          turnId: "turn-1",
          version: 2
        }
      ]
    }
  });
  assert.equal(inline.inlineApplied, true);

  const appended = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      messageId: "reasoning-live",
      turnId: "turn-1",
      role: "assistant",
      kind: "reasoning",
      occurredAtUnixMs: 4,
      content: { operation: "append_text", text: "检查" }
    }
  });

  assert.equal(appended.accepted, true);
  assert.equal(appended.reason, "applied");
  const projected = harness.coordinator.project(harness.readCanonicalSnapshot())
    .sessionMessagesById["session-1"];
  assert.equal(
    projected?.find((item) => item.messageId === "reasoning-live")?.payload
      .text,
    "正在检查"
  );
  assert.equal(
    projected?.find((item) => item.messageId === "message-2")?.payload.text,
    "其他消息"
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("previews a gapped tool update without advancing the durable cursor", () => {
  const harness = createHarness();
  harness.engine.dispatch({
    session: session(turn("running", 1), 1),
    type: "session/upserted"
  });
  harness.engine.dispatch({
    messages: [message("session-1", "message-1", "canonical")],
    type: "message/snapshotReceived",
    workspaceId: "workspace-1"
  });

  const previewed = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "message_update",
      latestVersion: 3,
      acceptedCount: 1,
      messages: [
        {
          agentSessionId: "session-1",
          kind: "tool_call",
          messageId: "tool-1",
          occurredAtUnixMs: 3,
          payload: { toolName: "Read", title: "Read" },
          role: "assistant",
          sequence: 3,
          status: "running",
          turnId: "turn-1",
          version: 3
        }
      ]
    }
  });

  assert.equal(previewed.inlineApplied, false);
  assert.equal(previewed.inlinePreviewed, true);
  assert.deepEqual(previewed.inlineGap, {
    cachedVersion: 1,
    firstUnseenVersion: 3,
    latestIncomingVersion: 3
  });
  assert.equal(
    harness
      .readCanonicalSnapshot()
      .sessionMessagesById["session-1"]?.some(
        (item) => item.messageId === "tool-1"
      ),
    false
  );
  assert.equal(
    harness.coordinator
      .project(harness.readCanonicalSnapshot())
      .sessionMessagesById["session-1"]?.find(
        (item) => item.messageId === "tool-1"
      )?.status,
    "running"
  );
  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-1" &&
        command.scope === "messages"
    )
  );

  const output = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      messageId: "tool-1",
      turnId: "turn-1",
      role: "assistant",
      kind: "tool_call",
      occurredAtUnixMs: 4,
      toolOutput: {
        operation: "append_text",
        text: "output",
        offsetBytes: 0
      }
    }
  });
  assert.equal(output.accepted, true);
  assert.deepEqual(
    harness.coordinator
      .project(harness.readCanonicalSnapshot())
      .sessionMessagesById["session-1"]?.find(
        (item) => item.messageId === "tool-1"
      )?.payload.output,
    { text: "output" }
  );

  const completed = {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: "tool-1",
    version: 4,
    sequence: 3,
    turnId: "turn-1",
    role: "assistant" as const,
    kind: "tool_call",
    status: "completed",
    payload: {
      toolName: "Read",
      title: "Read",
      output: { text: "output" }
    },
    occurredAtUnixMs: 5,
    completedAtUnixMs: 5
  };
  harness.coordinator.reconcileAuthoritativeHistory(
    "session-1",
    [completed],
    [turn("settled", 5)]
  );
  const finalTools = harness.coordinator
    .project({
      ...harness.readCanonicalSnapshot(),
      sessionMessagesById: { "session-1": [completed] }
    })
    .sessionMessagesById["session-1"]?.filter(
      (item) => item.messageId === "tool-1"
    );
  assert.equal(finalTools?.length, 1);
  assert.equal(finalTools?.[0]?.status, "completed");
  harness.coordinator.dispose();
  harness.engine.dispose();
});

for (const terminalStatus of ["completed", "canceled"] as const) {
  test(`keeps one visible tool row when a gapped preview becomes ${terminalStatus}`, () => {
    const harness = createHarness();
    harness.engine.dispatch({
      session: session(turn("running", 1), 1),
      type: "session/upserted"
    });
    harness.engine.dispatch({
      messages: [message("session-1", "message-1", "canonical")],
      type: "message/snapshotReceived",
      workspaceId: "workspace-1"
    });

    harness.coordinator.ingestEvent(toolUpdateEvent(3, "running"));
    const terminal = harness.coordinator.ingestEvent(
      toolUpdateEvent(4, terminalStatus)
    );

    assert.equal(terminal.inlineApplied, false);
    assert.equal(terminal.inlinePreviewed, true);
    const projected = harness.coordinator
      .project(harness.readCanonicalSnapshot())
      .sessionMessagesById["session-1"]?.filter(
        (item) => item.messageId === "tool-1"
      );
    assert.equal(projected?.length, 1);
    assert.equal(projected?.[0]?.status, terminalStatus);
    assert.equal(
      harness
        .readCanonicalSnapshot()
        .sessionMessagesById["session-1"]?.some(
          (item) => item.messageId === "tool-1"
        ),
      false
    );
    harness.coordinator.dispose();
    harness.engine.dispose();
  });
}

test("an explicit restore event clears only its tombstone and requests authoritative hydration", () => {
  const harness = createHarness();
  harness.engine.dispatch({
    session: session(null, 10),
    type: "session/upserted"
  });
  harness.coordinator.ingestEvent({
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

  const restored = harness.coordinator.ingestEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "session_restored",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "session_restored",
      restoredAtUnixMs: 12
    }
  });

  assert.equal(restored.reason, "restored");
  assert.equal(harness.coordinator.isSessionDeleted("session-1"), false);
  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-1"
    )
  );
  harness.engine.dispatch({
    session: session(null, 10),
    type: "session/upserted"
  });
  assert.equal(
    harness
      .readCanonicalSnapshot()
      .sessions.some((candidate) => candidate.agentSessionId === "session-1"),
    true
  );
  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("applies a settled Turn and its cleared Session reference atomically", () => {
  const harness = createHarness();
  const runningTurn = turn("running", 1);
  harness.engine.dispatch({
    session: session(runningTurn, 1),
    type: "session/upserted"
  });
  const observations: Array<{
    activeTurnId: string | null;
    turnPhase: AgentActivityTurn["phase"] | null;
  }> = [];
  const unsubscribe = harness.engine.subscribe((state) => {
    observations.push({
      activeTurnId:
        state.sessionLifecycle.sessionsById["session-1"]?.activeTurnId ?? null,
      turnPhase:
        state.sessionLifecycle.turnsById[
          canonicalTurnKey("session-1", "turn-1")
        ]?.phase ?? null
    });
  });

  const result = harness.coordinator.ingestEvent(turnUpdateEvent("settled", 2));
  const lifecycle = harness.engine.getSnapshot().sessionLifecycle;

  assert.equal(result.accepted, true);
  assert.equal(lifecycle.sessionsById["session-1"]?.activeTurnId, null);
  assert.equal(lifecycle.sessionsById["session-1"]?.updatedAtUnixMs, 1);
  assert.equal(
    lifecycle.turnsById[canonicalTurnKey("session-1", "turn-1")]?.phase,
    "settled"
  );
  assert.equal(
    harness.engine.getSnapshot().attentionReadState.partitionsByUserId["user-1"]
      ?.recordsBySessionId["session-1"]?.isUnread,
    true
  );
  assert.ok(
    observations.every(
      (observation) =>
        observation.turnPhase !== "settled" || observation.activeTurnId === null
    )
  );
  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-1" &&
        command.live &&
        command.scope === "state_and_messages"
    )
  );

  unsubscribe();
  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("rejects a late Turn fact without leaking completion into attention", () => {
  const harness = createHarness();
  const runningTurn = turn("running", 4);
  harness.engine.dispatch({
    session: session(runningTurn, 4),
    type: "session/upserted"
  });

  const result = harness.coordinator.ingestEvent(
    turnUpdateEvent("settled", 2, "turn-1", 100)
  );
  const snapshot = harness.engine.getSnapshot();

  assert.equal(result.accepted, true);
  assert.equal(
    snapshot.sessionLifecycle.turnsById[canonicalTurnKey("session-1", "turn-1")]
      ?.phase,
    "running"
  );
  assert.equal(
    snapshot.sessionLifecycle.sessionsById["session-1"]?.activeTurnId,
    "turn-1"
  );
  assert.equal(
    snapshot.attentionReadState.partitionsByUserId["user-1"],
    undefined
  );

  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("accepts host-fenced settlement across source version domains", () => {
  const harness = createHarness();
  const runningTurn = turn("running", 4);
  harness.engine.dispatch({
    session: session(runningTurn, 4),
    type: "session/upserted"
  });

  const result = harness.coordinator.ingestEvent(
    turnUpdateEvent("settled", 2, "turn-1", 100),
    { hostFencedSameTurnSettlement: true }
  );
  const snapshot = harness.engine.getSnapshot();

  assert.equal(result.accepted, true);
  assert.equal(
    snapshot.sessionLifecycle.turnsById[canonicalTurnKey("session-1", "turn-1")]
      ?.phase,
    "settled"
  );
  assert.equal(
    snapshot.sessionLifecycle.sessionsById["session-1"]?.activeTurnId,
    null
  );

  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("replays an accepted completion after live reconcile supplies identity", () => {
  const harness = createHarness();
  const settledTurn = turn("settled", 2);
  harness.coordinator.ingestEvent(turnUpdateEvent("settled", 2));
  assert.equal(
    harness.engine.getSnapshot().attentionReadState.partitionsByUserId[
      "user-1"
    ],
    undefined
  );
  const reconciled = session(null, 2);
  reconciled.latestTurn = settledTurn;

  harness.engine.dispatch({
    childSessions: [],
    live: true,
    session: reconciled,
    turns: [],
    type: "session/detailSnapshotReceived",
    workspaceId: "workspace-1"
  });

  assert.equal(
    harness.engine.getSnapshot().attentionReadState.partitionsByUserId["user-1"]
      ?.recordsBySessionId["session-1"]?.isUnread,
    true
  );

  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("stale historical snapshot cannot leak completion into attention", () => {
  const harness = createHarness();
  const runningTurn = turn("running", 4);
  harness.engine.dispatch({
    session: session(runningTurn, 4),
    type: "session/upserted"
  });
  const stale = session(null, 2);
  stale.latestTurn = turn("settled", 2);

  harness.engine.dispatch({
    sessions: [stale],
    type: "session/snapshotReceived"
  });

  assert.equal(
    harness.engine.getSnapshot().attentionReadState.partitionsByUserId[
      "user-1"
    ],
    undefined
  );

  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("rejected historical snapshot cannot replace newer attention", () => {
  const harness = createHarness();
  const oldTurn = turn("settled", 2, "turn-a");
  harness.engine.dispatch({
    live: true,
    turn: oldTurn,
    type: "turn/upserted"
  });
  harness.engine.dispatch({
    session: session(null, 10),
    type: "session/upserted"
  });
  harness.engine.dispatch({
    activeTurnId: null,
    turn: turn("settled", 10, "turn-b"),
    type: "turn/projectionReceived",
    workspaceId: "workspace-1"
  });
  const stale = session(null, 2);
  stale.latestTurn = oldTurn;

  harness.engine.dispatch({
    sessions: [stale],
    type: "session/snapshotReceived"
  });

  assert.deepEqual(
    harness.engine.getSnapshot().attentionReadState.partitionsByUserId["user-1"]
      ?.recordsBySessionId["session-1"],
    {
      completionKey: "turn:session-1:turn-b:completed",
      isUnread: true,
      kind: "completed",
      markedUnreadByUser: false,
      observationProvenance: "live",
      readStateProvenance: "live"
    }
  );

  harness.coordinator.dispose();
  harness.engine.dispose();
});

test("rejects an inconsistent Turn projection and reconciles state", () => {
  const harness = createHarness();
  const runningTurn = turn("running", 1);
  harness.engine.dispatch({
    session: session(runningTurn, 1),
    type: "session/upserted"
  });
  const inconsistent = turnUpdateEvent("settled", 2);
  inconsistent.data.activeTurnId = "turn-1";

  const result = harness.coordinator.ingestEvent(inconsistent);
  const lifecycle = harness.engine.getSnapshot().sessionLifecycle;

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "invalid_turn");
  assert.equal(
    lifecycle.turnsById[canonicalTurnKey("session-1", "turn-1")]?.phase,
    "running"
  );
  assert.equal(lifecycle.sessionsById["session-1"]?.activeTurnId, "turn-1");
  assert.ok(
    harness.commands.some(
      (command) =>
        command.type === "session/reconcile" &&
        command.agentSessionId === "session-1" &&
        command.live &&
        command.scope === "state"
    )
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

function toolUpdateEvent(
  version: number,
  status: "running" | "completed" | "canceled"
): Extract<AgentActivityUpdatedEvent, { eventType: "message_update" }> {
  const terminal = status !== "running";
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "message_update",
      latestVersion: version,
      acceptedCount: 1,
      messages: [
        {
          agentSessionId: "session-1",
          kind: "tool_call",
          messageId: "tool-1",
          occurredAtUnixMs: version,
          ...(terminal ? { completedAtUnixMs: version } : {}),
          payload: { toolName: "Read", title: "Read" },
          role: "assistant",
          sequence: 3,
          status,
          turnId: "turn-1",
          version
        }
      ]
    }
  };
}

function session(turnValue: AgentActivityTurn | null, updatedAtUnixMs: number) {
  return normalizeAgentActivitySession({
    activeTurn: turnValue,
    activeTurnId: turnValue?.turnId ?? null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    latestTurn: turnValue,
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: "Session",
    updatedAtUnixMs,
    userId: "user-1",
    workspaceId: "workspace-1"
  });
}

function turn(
  phase: AgentActivityTurn["phase"],
  updatedAtUnixMs: number,
  turnId = "turn-1"
): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    ...(phase === "settled"
      ? {
          completedCommand: null,
          error: null,
          fileChanges: null,
          outcome: "completed" as const,
          settledAtUnixMs: updatedAtUnixMs
        }
      : {}),
    origin: "user_prompt",
    phase,
    startedAtUnixMs: 1,
    turnId,
    updatedAtUnixMs
  };
}

function turnUpdateEvent(
  phase: AgentActivityTurn["phase"],
  updatedAtUnixMs: number,
  turnId = "turn-1",
  occurredAtUnixMs = updatedAtUnixMs
): AgentActivityTurnUpdatedEvent {
  const turnValue = turn(phase, updatedAtUnixMs, turnId);
  return {
    agentSessionId: "session-1",
    data: {
      activeTurnId: phase === "settled" ? null : turnId,
      agentSessionId: "session-1",
      eventType: "turn_update",
      occurredAtUnixMs,
      turn: {
        ...turnValue,
        completedCommand: null,
        error: turnValue.error ?? null,
        fileChanges: turnValue.fileChanges ?? null,
        outcome: turnValue.outcome ?? null,
        settledAtUnixMs: turnValue.settledAtUnixMs ?? null
      },
      workspaceId: "workspace-1"
    },
    eventType: "turn_update",
    workspaceId: "workspace-1"
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
