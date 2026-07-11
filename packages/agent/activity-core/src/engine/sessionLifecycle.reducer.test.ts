import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivitySession, AgentActivityTurn } from "../types.ts";
import {
  createInitialSessionLifecycleState,
  sessionLifecycleReducer
} from "./sessionLifecycle.reducer.ts";

test("snapshot decomposes protocol v2 session and turn entities", () => {
  const result = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(2), 2)]
  });
  const record = result.state.recordsBySessionId["session-1"];
  assert.equal(record?.session.activeTurnId, "turn-1");
  assert.equal(record?.session.activeTurn, undefined);
  assert.equal(record?.activeTurn?.phase, "running");
});

test("cancel request targets the exact active turn and deduplicates", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(2), 2)]
  }).state;
  const requested = reduce(state, {
    type: "session/cancelRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    commandId: "cancel-1"
  });
  assert.deepEqual(requested.commands[0], {
    type: "turn/cancel",
    commandId: "cancel-1",
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    turnId: "turn-1",
    timeoutMs: 30_000
  });
  assert.equal(
    reduce(requested.state, {
      type: "session/cancelRequested",
      agentSessionId: "session-1",
      awaitingTurnExpiresAtUnixMs: 30_000,
      commandId: "cancel-2"
    }).commands.length,
    0
  );
});

test("cancel requested before turn creation waits for a v2 turn entity", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(null, 1)]
  }).state;
  const waiting = reduce(state, {
    type: "session/cancelRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    commandId: "cancel-1"
  });
  assert.equal(
    waiting.state.recordsBySessionId["session-1"]?.cancel.status,
    "awaitingTurn"
  );
  const started = reduce(waiting.state, {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(2), 2)]
  });
  assert.ok(started.commands.some((command) => command.type === "turn/cancel"));
});

test("metadata updates do not abandon an awaiting cancel before its expiry", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(null, 1)]
  }).state;
  state = reduce(state, {
    type: "session/cancelRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    commandId: "cancel-1"
  }).state;
  const advanced = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(null, 2)]
  });
  assert.equal(
    advanced.state.recordsBySessionId["session-1"]?.cancel.status,
    "awaitingTurn"
  );
});

test("awaiting cancel expires deterministically and cannot cancel a future turn", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(null, 1)]
  }).state;
  const waiting = reduce(state, {
    type: "session/cancelRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 100,
    commandId: "cancel-1"
  });
  assert.deepEqual(waiting.commands, [
    {
      dueAtUnixMs: 100,
      expiryId: "cancel:awaiting-turn:cancel-1",
      type: "engine/scheduleExpiry"
    }
  ]);
  state = reduce(waiting.state, {
    type: "engine/intentExpired",
    dueAtUnixMs: 100,
    expiryId: "cancel:awaiting-turn:cancel-1"
  }).state;
  const futureTurn = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(101), 101)]
  });
  assert.equal(futureTurn.commands.length, 0);
  assert.equal(
    futureTurn.state.recordsBySessionId["session-1"]?.cancel.status,
    "idle"
  );
});

test("idempotent not-found cancel clears only its target and requests reconcile", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(2), 2)]
  }).state;
  state = reduce(state, {
    type: "session/cancelRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    commandId: "cancel-1"
  }).state;
  const settled = reduce(state, {
    type: "engine/commandResult",
    commandId: "cancel-1",
    commandType: "turn/cancel",
    outcome: "succeeded",
    value: { cancel: { canceled: false, reason: "not_found" } }
  });
  assert.equal(settled.state.recordsBySessionId["session-1"]?.activeTurn, null);
  assert.equal(
    settled.state.recordsBySessionId["session-1"]?.session.activeTurnId,
    null
  );
  assert.deepEqual(settled.commands, [
    {
      commandId: "engine:reconcile:cancel:cancel-1",
      type: "engine/reconcileWorkspace",
      workspaceId: "workspace-1"
    }
  ]);
});

test("authoritative settled state clears a cancel timeout failure", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(2), 2)]
  }).state;
  state = reduce(state, {
    type: "session/cancelRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    commandId: "cancel-1"
  }).state;
  state = reduce(state, {
    type: "engine/commandResult",
    commandId: "cancel-1",
    commandType: "turn/cancel",
    outcome: "timedOut"
  }).state;
  assert.equal(state.recordsBySessionId["session-1"]?.cancel.status, "failed");
  const authoritative = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(null, 3)]
  });
  assert.equal(
    authoritative.state.recordsBySessionId["session-1"]?.cancel.status,
    "idle"
  );
  assert.equal(
    authoritative.state.recordsBySessionId["session-1"]?.operationError,
    null
  );
});

test("cancel result for another session cannot enter canonical turn state", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(2), 2)]
  }).state;
  state = reduce(state, {
    type: "session/cancelRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    commandId: "cancel-1"
  }).state;
  const mismatched = reduce(state, {
    type: "engine/commandResult",
    commandId: "cancel-1",
    commandType: "turn/cancel",
    outcome: "succeeded",
    value: {
      cancel: { canceled: true, reason: "turn_canceled" },
      turn: {
        ...activeTurn(3),
        agentSessionId: "session-2",
        phase: "settled",
        outcome: "canceled"
      }
    }
  });
  assert.equal(
    mismatched.state.recordsBySessionId["session-1"]?.activeTurn?.phase,
    "running"
  );
  assert.equal(mismatched.commands[0]?.type, "engine/reconcileWorkspace");
});

test("late cancel result for turn A cannot overwrite newer turn B", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(2), 2)]
  }).state;
  state = reduce(state, {
    type: "session/cancelRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    commandId: "cancel-1"
  }).state;
  const turnB = { ...activeTurn(4), turnId: "turn-2" };
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(turnB, 4)]
  }).state;
  const late = reduce(state, {
    type: "engine/commandResult",
    commandId: "cancel-1",
    commandType: "turn/cancel",
    outcome: "succeeded",
    value: {
      cancel: { canceled: true, reason: "turn_canceled" },
      turn: { ...activeTurn(3), phase: "settled", outcome: "canceled" }
    }
  });
  assert.equal(
    late.state.recordsBySessionId["session-1"]?.activeTurn?.turnId,
    "turn-2"
  );
});

test("same-millisecond snapshots cannot replace or clear a different live turn", () => {
  const turnB = { ...activeTurn(2), turnId: "turn-b" };
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(turnB, 2)]
  }).state;
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(null, 2)]
  }).state;
  assert.equal(
    state.recordsBySessionId["session-1"]?.activeTurn?.turnId,
    "turn-b"
  );
  const turnA = { ...activeTurn(2), turnId: "turn-a" };
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(turnA, 2)]
  }).state;
  assert.equal(
    state.recordsBySessionId["session-1"]?.activeTurn?.turnId,
    "turn-b"
  );
});

test("deleted session tombstone rejects late snapshot resurrection", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(null, 1)]
  }).state;
  state = reduce(state, {
    type: "session/removed",
    agentSessionId: "session-1"
  }).state;
  const late = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(2), 2)]
  });
  assert.equal(late.state.recordsBySessionId["session-1"], undefined);
});

function reduce(
  state: ReturnType<typeof createInitialSessionLifecycleState>,
  intent: Parameters<typeof sessionLifecycleReducer>[1]
) {
  return sessionLifecycleReducer(state, intent);
}

function session(
  turn: AgentActivityTurn | null,
  updatedAtUnixMs: number
): AgentActivitySession {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/workspace",
    title: "Session",
    status: "working",
    activeTurnId: turn?.turnId ?? null,
    activeTurn: turn,
    pendingInteractions: [],
    updatedAtUnixMs
  };
}

function activeTurn(updatedAtUnixMs: number): AgentActivityTurn {
  return {
    turnId: "turn-1",
    agentSessionId: "session-1",
    phase: "running",
    startedAtUnixMs: 1,
    updatedAtUnixMs
  };
}
