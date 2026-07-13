import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivityTurn
} from "../types.ts";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import {
  createInitialSessionLifecycleState,
  sessionLifecycleReducer
} from "./sessionLifecycle.reducer.ts";
import {
  canonicalInteractionKey,
  canonicalTurnKey
} from "./sessionEntityKeys.ts";
import {
  selectEngineInteraction,
  selectEngineTurn
} from "./sessionLifecycle.selectors.ts";
import { createInitialAgentSessionEngineState } from "./rootReducer.ts";
import { validateSendInputResult } from "./commandResult.validation.ts";

test("snapshot decomposes protocol v2 session and turn entities", () => {
  const result = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(2), 2)]
  });
  assert.equal(result.state.sessionsById["session-1"]?.activeTurnId, "turn-1");
  assert.equal(
    result.state.turnsById[canonicalTurnKey("session-1", "turn-1")]?.phase,
    "running"
  );
  assert.equal("recordsBySessionId" in result.state, false);
  assert.equal(
    "activeTurn" in (result.state.sessionsById["session-1"] ?? {}),
    false
  );
  assert.equal(
    "turnLifecycle" in (result.state.sessionsById["session-1"] ?? {}),
    false
  );
});

test("snapshot restores a settled latest turn without an active turn", () => {
  const latestTurn: AgentActivityTurn = {
    ...activeTurn(7),
    phase: "settled",
    outcome: "failed",
    settledAtUnixMs: 7
  };
  const source = session(null, 7);
  source.latestTurn = latestTurn;
  const result = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [source]
  });
  assert.equal(result.state.sessionsById["session-1"]?.activeTurnId, null);
  assert.deepEqual(
    result.state.turnsById[canonicalTurnKey("session-1", "turn-1")],
    latestTurn
  );
});

test("send command result atomically upserts its scoped session and turn", () => {
  const turn = activeTurn(4);
  const result = reduce(createInitialSessionLifecycleState(), {
    commandId: "send-1",
    commandType: "queue/sendPrompt",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: { session: session(turn, 4), turn, turnId: turn.turnId }
  });
  assert.equal(result.state.sessionsById["session-1"]?.activeTurnId, "turn-1");
  assert.deepEqual(
    result.state.turnsById[canonicalTurnKey("session-1", "turn-1")],
    turn
  );
});

test("send command result rejects session and turn scope mismatch atomically", () => {
  const turn = { ...activeTurn(4), agentSessionId: "session-other" };
  const result = reduce(createInitialSessionLifecycleState(), {
    commandId: "send-1",
    commandType: "queue/sendPrompt",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: { session: session(null, 4), turn, turnId: turn.turnId }
  });
  assert.deepEqual(result.state, createInitialSessionLifecycleState());
});

test("snapshot scopes identical latest turn ids by session", () => {
  const first = session(null, 8);
  first.latestTurn = {
    ...activeTurn(8),
    phase: "settled",
    outcome: "completed"
  };
  const second = {
    ...session(null, 9),
    agentSessionId: "session-2",
    latestTurn: {
      ...activeTurn(9),
      agentSessionId: "session-2",
      phase: "settled" as const,
      outcome: "failed" as const
    }
  };
  const result = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [first, second]
  });
  assert.equal(
    result.state.turnsById[canonicalTurnKey("session-1", "turn-1")]?.outcome,
    "completed"
  );
  assert.equal(
    result.state.turnsById[canonicalTurnKey("session-2", "turn-1")]?.outcome,
    "failed"
  );
});

test("turn and interaction events update independent canonical collections", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(null, 1)]
  }).state;
  state = reduce(state, {
    type: "turn/upserted",
    turn: activeTurn(2)
  }).state;
  const pending = interaction("pending", 3);
  state = reduce(state, {
    type: "interaction/upserted",
    interaction: pending
  }).state;
  assert.equal(
    state.turnsById[canonicalTurnKey("session-1", "turn-1")]?.phase,
    "running"
  );
  assert.equal(
    state.interactionsById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ]?.status,
    "pending"
  );

  state = reduce(state, {
    type: "interaction/upserted",
    interaction: interaction("answered", 4)
  }).state;
  assert.equal(
    state.interactionsById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ]?.status,
    "answered"
  );
});

test("interaction response is request-scoped, deduplicated, and canonically confirmed", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(1), 1)]
  }).state;
  state = reduce(state, {
    type: "interaction/upserted",
    interaction: interaction("pending", 2)
  }).state;
  const requested = reduce(state, interactionResponseRequested("respond-1"));
  assert.deepEqual(requested.commands, [
    {
      agentSessionId: "session-1",
      commandId: "respond-1",
      correlationId: canonicalInteractionKey(
        "session-1",
        "turn-1",
        "request-1"
      ),
      optionId: "approve",
      requestId: "request-1",
      turnId: "turn-1",
      timeoutMs: 30_000,
      type: "interaction/respond",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    requested.state.interactionResponsesById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ]?.status,
    "responding"
  );
  const duplicate = reduce(
    requested.state,
    interactionResponseRequested("respond-2")
  );
  assert.deepEqual(duplicate.commands, []);
  const acknowledged = reduce(requested.state, {
    commandId: "respond-1",
    commandType: "interaction/respond",
    correlationId: canonicalInteractionKey("session-1", "turn-1", "request-1"),
    outcome: "succeeded",
    type: "engine/commandResult"
  });
  assert.equal(
    acknowledged.state.interactionResponsesById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ]?.status,
    "unknown"
  );
  const confirmed = reduce(acknowledged.state, {
    type: "interaction/upserted",
    interaction: interaction("answered", 3)
  });
  assert.equal(
    confirmed.state.interactionResponsesById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ],
    undefined
  );
});

test("interaction timeout and late cross-scope results never become success", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(1), 1)]
  }).state;
  state = reduce(state, {
    type: "interaction/upserted",
    interaction: interaction("pending", 2)
  }).state;
  state = reduce(state, interactionResponseRequested("respond-1")).state;
  const wrongScope = reduce(state, {
    commandId: "respond-1",
    commandType: "interaction/respond",
    correlationId: canonicalInteractionKey(
      "session-other",
      "turn-1",
      "request-1"
    ),
    outcome: "succeeded",
    type: "engine/commandResult"
  });
  assert.equal(wrongScope.state, state);
  const timedOut = reduce(state, {
    commandId: "respond-1",
    commandType: "interaction/respond",
    correlationId: canonicalInteractionKey("session-1", "turn-1", "request-1"),
    outcome: "timedOut",
    type: "engine/commandResult"
  });
  const response =
    timedOut.state.interactionResponsesById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ];
  assert.equal(response?.status, "unknown");
  assert.equal(response?.errorCode, "timeout");
  assert.deepEqual(
    reduce(timedOut.state, interactionResponseRequested("respond-2")).commands,
    []
  );
});

test("terminal canonical session snapshot confirms an acknowledged response", () => {
  const source = session(activeTurn(1), 1);
  source.pendingInteractions = [interaction("pending", 1)];
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [source]
  }).state;
  state = reduce(state, interactionResponseRequested("respond-1")).state;
  state = reduce(state, {
    commandId: "respond-1",
    commandType: "interaction/respond",
    correlationId: canonicalInteractionKey("session-1", "turn-1", "request-1"),
    outcome: "succeeded",
    type: "engine/commandResult"
  }).state;
  const terminal = session(activeTurn(3), 3);
  terminal.pendingInteractions = [];
  terminal.latestTurnInteractions = [interaction("answered", 3)];
  const confirmed = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [terminal]
  });
  assert.equal(
    confirmed.state.interactionResponsesById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ],
    undefined
  );
});

test("interaction response rejects a request from another session", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(1), 1)]
  }).state;
  state = reduce(state, {
    type: "interaction/upserted",
    interaction: interaction("pending", 2)
  }).state;
  const result = reduce(state, {
    ...interactionResponseRequested("respond-other"),
    agentSessionId: "session-other"
  });
  assert.deepEqual(result.commands, []);
  assert.equal(result.state, state);
});

test("session metadata patches update the canonical session without a list overlay", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(null, 1)]
  }).state;
  state = reduce(state, {
    type: "session/metadataPatched",
    agentSessionId: "session-1",
    patch: { title: "Renamed", updatedAtUnixMs: 2 }
  }).state;
  assert.equal(state.sessionsById["session-1"]?.title, "Renamed");
  assert.equal(state.sessionsById["session-1"]?.updatedAtUnixMs, 2);
});

test("identical turn and request ids remain isolated by session", () => {
  const turn1 = activeTurn(2);
  const turn2 = { ...activeTurn(3), agentSessionId: "session-2" };
  const interaction1 = interaction("pending", 2);
  const interaction2 = {
    ...interaction("pending", 3),
    agentSessionId: "session-2"
  };
  const session1 = session(turn1, 2);
  session1.pendingInteractions = [interaction1];
  const session2 = {
    ...session(turn2, 3),
    agentSessionId: "session-2",
    pendingInteractions: [interaction2]
  };
  const lifecycle = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session1, session2]
  }).state;
  const engineState = {
    ...createInitialAgentSessionEngineState(),
    sessionLifecycle: lifecycle
  };

  assert.equal(
    selectEngineTurn(engineState, "session-1", "turn-1")?.agentSessionId,
    "session-1"
  );
  assert.equal(
    selectEngineTurn(engineState, "session-2", "turn-1")?.agentSessionId,
    "session-2"
  );
  assert.equal(
    selectEngineInteraction(engineState, "session-1", "turn-1", "request-1")
      ?.agentSessionId,
    "session-1"
  );
  assert.equal(
    selectEngineInteraction(engineState, "session-2", "turn-1", "request-1")
      ?.agentSessionId,
    "session-2"
  );
});

test("identical request ids remain isolated across turns in one session", () => {
  const turn1 = activeTurn(1);
  const turn2 = { ...activeTurn(2), turnId: "turn-2" };
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(turn1, 1)]
  }).state;
  state = reduce(state, { type: "turn/upserted", turn: turn2 }).state;
  state = reduce(state, {
    type: "interaction/upserted",
    interaction: interaction("pending", 2)
  }).state;
  state = reduce(state, {
    type: "interaction/upserted",
    interaction: { ...interaction("pending", 3), turnId: "turn-2" }
  }).state;

  assert.equal(
    state.interactionsById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ]?.turnId,
    "turn-1"
  );
  assert.equal(
    state.interactionsById[
      canonicalInteractionKey("session-1", "turn-2", "request-1")
    ]?.turnId,
    "turn-2"
  );
});

test("authoritative snapshots remove pending interactions that are no longer present", () => {
  const withPending = session(activeTurn(2), 2);
  withPending.pendingInteractions = [interaction("pending", 2)];
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [withPending]
  }).state;
  assert.equal(
    state.interactionsById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ]?.status,
    "pending"
  );

  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(3), 3)]
  }).state;
  assert.equal(
    state.interactionsById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ],
    undefined
  );
});

for (const intentType of [
  "session/snapshotReceived",
  "session/upserted"
] as const) {
  test(`${intentType} only removes omitted pending interactions at an authoritative version`, () => {
    let state = reduce(createInitialSessionLifecycleState(), {
      type: "session/snapshotReceived",
      sessions: [session(activeTurn(1), 1)]
    }).state;
    state = reduce(state, {
      type: "interaction/upserted",
      interaction: interaction("pending", 4)
    }).state;

    const olderEmpty = session(activeTurn(3), 3);
    state = reduce(
      state,
      intentType === "session/snapshotReceived"
        ? { type: intentType, sessions: [olderEmpty] }
        : { type: intentType, session: olderEmpty }
    ).state;
    assert.equal(
      state.interactionsById[
        canonicalInteractionKey("session-1", "turn-1", "request-1")
      ]?.status,
      "pending"
    );

    const newerEmpty = session(activeTurn(5), 5);
    state = reduce(
      state,
      intentType === "session/snapshotReceived"
        ? { type: intentType, sessions: [newerEmpty] }
        : { type: intentType, session: newerEmpty }
    ).state;
    assert.equal(
      state.interactionsById[
        canonicalInteractionKey("session-1", "turn-1", "request-1")
      ],
      undefined
    );
  });
}

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
    waiting.state.operationBySessionId["session-1"]?.cancel.status,
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
    advanced.state.operationBySessionId["session-1"]?.cancel.status,
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
    futureTurn.state.operationBySessionId["session-1"]?.cancel.status,
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
  assert.equal(settled.state.sessionsById["session-1"]?.activeTurnId, "turn-1");
  assert.equal(
    settled.state.operationBySessionId["session-1"]?.cancel.status,
    "unknown"
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
  assert.equal(
    state.operationBySessionId["session-1"]?.cancel.status,
    "failed"
  );
  const authoritative = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(null, 3)]
  });
  assert.equal(
    authoritative.state.operationBySessionId["session-1"]?.cancel.status,
    "idle"
  );
  assert.equal(
    authoritative.state.operationBySessionId["session-1"]?.operationError,
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
    mismatched.state.turnsById[canonicalTurnKey("session-1", "turn-1")]?.phase,
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
  assert.equal(late.state.sessionsById["session-1"]?.activeTurnId, "turn-2");
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
  assert.equal(state.sessionsById["session-1"]?.activeTurnId, "turn-b");
  const turnA = { ...activeTurn(2), turnId: "turn-a" };
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session(turnA, 2)]
  }).state;
  assert.equal(state.sessionsById["session-1"]?.activeTurnId, "turn-b");
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
  assert.equal(late.state.sessionsById["session-1"], undefined);
  assert.equal(late.state.operationBySessionId["session-1"], undefined);
});

test("restart snapshot hydrates terminal latest-turn interactions", () => {
  const restored = session(null, 5);
  restored.latestTurn = {
    ...activeTurn(4),
    phase: "settled",
    outcome: "completed"
  };
  restored.latestTurnInteractions = [interaction("answered", 5)];
  const state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [restored]
  }).state;
  assert.equal(
    state.interactionsById[
      canonicalInteractionKey("session-1", "turn-1", "request-1")
    ]?.status,
    "answered"
  );
});

for (const terminal of ["answered", "superseded"] as const) {
  test(`stale pending snapshot cannot regress ${terminal} interaction`, () => {
    const current = session(activeTurn(4), 4);
    current.latestTurnInteractions = [interaction(terminal, 4)];
    let state = reduce(createInitialSessionLifecycleState(), {
      type: "session/snapshotReceived",
      sessions: [current]
    }).state;
    const stale = session(activeTurn(3), 3);
    stale.pendingInteractions = [interaction("pending", 3)];
    state = reduce(state, {
      type: "session/snapshotReceived",
      sessions: [stale]
    }).state;
    assert.equal(
      state.interactionsById[
        canonicalInteractionKey("session-1", "turn-1", "request-1")
      ]?.status,
      terminal
    );
  });
}

test("interaction then turn then session converges without exposing orphans", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "interaction/upserted",
    interaction: interaction("pending", 2)
  }).state;
  let engine = {
    ...createInitialAgentSessionEngineState(),
    sessionLifecycle: state
  };
  assert.equal(
    selectEngineInteraction(engine, "session-1", "turn-1", "request-1"),
    null
  );
  state = reduce(state, { type: "turn/upserted", turn: activeTurn(2) }).state;
  engine = { ...engine, sessionLifecycle: state };
  assert.equal(selectEngineTurn(engine, "session-1", "turn-1"), null);
  const parentSession = session(null, 3);
  parentSession.pendingInteractions = [interaction("pending", 2)];
  state = reduce(state, {
    type: "session/upserted",
    session: parentSession
  }).state;
  engine = { ...engine, sessionLifecycle: state };
  assert.equal(
    selectEngineTurn(engine, "session-1", "turn-1")?.turnId,
    "turn-1"
  );
  assert.equal(
    selectEngineInteraction(engine, "session-1", "turn-1", "request-1")?.status,
    "pending"
  );
});

test("delete tombstone rejects late orphan turn and interaction upserts", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [session(activeTurn(1), 1)]
  }).state;
  state = reduce(state, {
    type: "session/removed",
    agentSessionId: "session-1"
  }).state;
  state = reduce(state, { type: "turn/upserted", turn: activeTurn(2) }).state;
  state = reduce(state, {
    type: "interaction/upserted",
    interaction: interaction("pending", 2)
  }).state;
  assert.equal(Object.keys(state.turnsById).length, 0);
  assert.equal(Object.keys(state.interactionsById).length, 0);
});

test("settled turn is terminal against newer live phases and outcome changes", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "turn/upserted",
    turn: { ...activeTurn(2), phase: "settled", outcome: "completed" }
  }).state;
  state = reduce(state, {
    type: "turn/upserted",
    turn: { ...activeTurn(3), phase: "running" }
  }).state;
  state = reduce(state, {
    type: "turn/upserted",
    turn: { ...activeTurn(4), phase: "settled", outcome: "failed" }
  }).state;
  const turn = state.turnsById[canonicalTurnKey("session-1", "turn-1")];
  assert.equal(turn?.phase, "settled");
  assert.equal(turn?.outcome, "completed");
});

test("running and waiting transitions remain bidirectional before settle", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "turn/upserted",
    turn: activeTurn(1)
  }).state;
  state = reduce(state, {
    type: "turn/upserted",
    turn: { ...activeTurn(2), phase: "waiting" }
  }).state;
  assert.equal(
    state.turnsById[canonicalTurnKey("session-1", "turn-1")]?.phase,
    "waiting"
  );
  state = reduce(state, {
    type: "turn/upserted",
    turn: activeTurn(3)
  }).state;
  assert.equal(
    state.turnsById[canonicalTurnKey("session-1", "turn-1")]?.phase,
    "running"
  );
});

test("equal timestamp terminal turn wins and invalid settling regression is rejected", () => {
  let state = reduce(createInitialSessionLifecycleState(), {
    type: "turn/upserted",
    turn: { ...activeTurn(2), phase: "settling" }
  }).state;
  state = reduce(state, {
    type: "turn/upserted",
    turn: { ...activeTurn(2), phase: "running" }
  }).state;
  assert.equal(
    state.turnsById[canonicalTurnKey("session-1", "turn-1")]?.phase,
    "settling"
  );
  state = reduce(state, {
    type: "turn/upserted",
    turn: { ...activeTurn(2), phase: "settled", outcome: "completed" }
  }).state;
  assert.equal(
    state.turnsById[canonicalTurnKey("session-1", "turn-1")]?.phase,
    "settled"
  );
});

function reduce(
  state: ReturnType<typeof createInitialSessionLifecycleState>,
  intent: Parameters<typeof sessionLifecycleReducer>[1]
) {
  return sessionLifecycleReducer(state, intent, {
    queuePromotionAccepted: false,
    sendResultValidation:
      intent.type === "engine/commandResult" &&
      intent.commandType === "queue/sendPrompt" &&
      intent.outcome === "succeeded"
        ? validateSendInputResult(intent.value, {
            acceptedSessionVersion: null,
            agentSessionId: "session-1",
            clientSubmitId: "submit-1",
            content: [],
            errorCode: null,
            errorMessage: null,
            expiresAtUnixMs: 1,
            guidance: false,
            requestedAtUnixMs: 1,
            status: "requested",
            turnId: null,
            workspaceId: "workspace-1"
          })
        : null
  });
}

function session(
  turn: AgentActivityTurn | null,
  updatedAtUnixMs: number
): AgentActivitySession {
  return normalizeAgentActivitySession({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/workspace",
    title: "Session",
    activeTurnId: turn?.turnId ?? null,
    activeTurn: turn,
    pendingInteractions: [],
    updatedAtUnixMs
  });
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

function interactionResponseRequested(commandId: string) {
  return {
    type: "interaction/responseRequested" as const,
    agentSessionId: "session-1",
    commandId,
    optionId: "approve",
    requestId: "request-1",
    turnId: "turn-1",
    timeoutMs: 30_000,
    workspaceId: "workspace-1"
  };
}

function interaction(
  status: AgentActivityInteraction["status"],
  updatedAtUnixMs: number
): AgentActivityInteraction {
  return {
    requestId: "request-1",
    agentSessionId: "session-1",
    turnId: "turn-1",
    kind: "question",
    status,
    createdAtUnixMs: 3,
    updatedAtUnixMs
  };
}
