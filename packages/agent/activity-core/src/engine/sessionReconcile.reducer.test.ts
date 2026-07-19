import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialSessionReconcileState,
  sessionReconcileReducer
} from "./sessionReconcile.reducer.ts";

test("activity observation derives reconcile scope inside the engine", () => {
  const result = reduce(createInitialSessionReconcileState(), {
    type: "session/activityObserved",
    agentSessionId: "session-1",
    eventType: "message_update",
    hasCachedSession: true,
    hasInlineMessages: false,
    inlineApplied: false,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(result.commands, [
    {
      agentSessionId: "session-1",
      commandId: "session:reconcile:session-1:1",
      scope: "state_and_messages",
      timeoutMs: 30_000,
      type: "session/reconcile",
      workspaceId: "workspace-1"
    }
  ]);
});

test("inline-applied activity does not schedule redundant transport work", () => {
  const result = reduce(createInitialSessionReconcileState(), {
    type: "session/activityObserved",
    agentSessionId: "session-1",
    eventType: "turn_update",
    hasCachedSession: true,
    hasInlineMessages: false,
    inlineApplied: true,
    workspaceId: "workspace-1"
  });
  assert.equal(result.commands.length, 0);
});

test("reconcile requests merge while one command is in flight and rerun once", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: false,
    workspaceId: "workspace-1"
  }).state;
  const merged = reduce(state, {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  });
  assert.equal(merged.commands.length, 0);
  state = merged.state;
  const settled = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "succeeded",
    value: foundResult()
  });
  assert.deepEqual(settled.commands, [
    {
      agentSessionId: "session-1",
      commandId: "session:reconcile:session-1:2",
      scope: "state",
      timeoutMs: 30_000,
      type: "session/reconcile",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(settled.followUpIntents?.[0]?.type, "session/upserted");
});

test("session removal discards queued reconcile demand", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  state = reduce(state, {
    evidence: { source: "session_deleted_event", deletedAtUnixMs: 1 },
    type: "session/removed",
    agentSessionId: "session-1"
  }).state;
  assert.equal(state.recordsBySessionId["session-1"], undefined);
});

test("a timed-out reconcile releases merged demand into the next command", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: false,
    workspaceId: "workspace-1"
  }).state;
  state = reduce(state, {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  const timedOut = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "timedOut"
  });
  assert.equal(timedOut.commands[0]?.type, "session/reconcile");
  assert.equal(
    timedOut.commands[0]?.type === "session/reconcile"
      ? timedOut.commands[0].scope
      : null,
    "state"
  );
});

test("absent reconcile never tombstones and ignores duplicate settles", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  const absent = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "succeeded",
    value: { kind: "absent" }
  });
  assert.equal(absent.followUpIntents, undefined);
  assert.equal(absent.commands.length, 0);
  assert.equal(absent.state.recordsBySessionId["session-1"]?.lastAbsent, true);
  assert.equal(
    absent.state.recordsBySessionId["session-1"]?.inFlightCommandId,
    null
  );

  const duplicate = reduce(absent.state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "succeeded",
    value: {
      kind: "deleted",
      evidence: {
        source: "session_deleted_event",
        deletedAtUnixMs: 9
      }
    }
  });
  assert.equal(duplicate.state, absent.state);
  assert.equal(duplicate.followUpIntents, undefined);
});

test("explicit deleted reconcile emits evidenced session/removed", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  const deleted = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "succeeded",
    value: {
      kind: "deleted",
      evidence: {
        source: "session_deleted_event",
        deletedAtUnixMs: 9
      }
    }
  });
  assert.deepEqual(deleted.followUpIntents, [
    {
      agentSessionId: "session-1",
      evidence: {
        source: "session_deleted_event",
        deletedAtUnixMs: 9
      },
      type: "session/removed"
    }
  ]);
  assert.equal(deleted.state.recordsBySessionId["session-1"], undefined);
});

test("found reconcile upserts session and turns atomically via follow-ups", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  const turn = {
    agentSessionId: "session-1",
    origin: "user_prompt" as const,
    phase: "settled" as const,
    outcome: "completed" as const,
    startedAtUnixMs: 1,
    settledAtUnixMs: 2,
    turnId: "turn-1",
    updatedAtUnixMs: 2
  };
  const found = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "succeeded",
    value: {
      kind: "found",
      live: true,
      session: {
        ...foundResult().session,
        latestTurn: turn
      },
      turns: [turn],
      messages: [
        {
          agentSessionId: "session-1",
          kind: "text",
          messageId: "m-1",
          occurredAtUnixMs: 1,
          payload: {},
          role: "assistant",
          status: "completed",
          turnId: "turn-1",
          version: 1,
          workspaceId: "workspace-1"
        }
      ]
    }
  });
  assert.deepEqual(
    found.followUpIntents?.map((intent) => intent.type),
    [
      "session/upserted",
      "turn/upserted",
      "turn/upserted",
      "message/snapshotReceived"
    ]
  );
});

function foundResult() {
  return {
    kind: "found" as const,
    session: {
      activeTurn: null,
      activeTurnId: null,
      agentSessionId: "session-1",
      cwd: "/workspace",
      latestTurn: null,
      latestTurnInteractions: [],
      pendingInteractions: [],
      provider: "codex",
      title: "Session",
      updatedAtUnixMs: 1,
      workspaceId: "workspace-1"
    }
  };
}

function reduce(
  state: ReturnType<typeof createInitialSessionReconcileState>,
  intent: Parameters<typeof sessionReconcileReducer>[1]
) {
  return sessionReconcileReducer(state, intent);
}
