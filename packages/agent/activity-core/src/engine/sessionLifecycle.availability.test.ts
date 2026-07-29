import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityInteraction, AgentActivityTurn } from "../types.ts";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import { deriveCanonicalSubmitAvailability } from "./sessionLifecycle.availability.ts";

test("canonical submit availability covers missing, interaction, active, and settled states", () => {
  const initial = createInitialAgentSessionEngineState();
  assert.deepEqual(
    deriveCanonicalSubmitAvailability(initial.sessionLifecycle, "session-1"),
    { state: "missing" }
  );

  const turn = {
    agentSessionId: "session-1",
    origin: "user_prompt" as const,
    phase: "running" as const,
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 1
  };
  const running = rootEngineReducer(initial, {
    type: "session/snapshotReceived",
    sessions: [session(turn, [])]
  }).state.sessionLifecycle;
  assert.deepEqual(deriveCanonicalSubmitAvailability(running, "session-1"), {
    state: "blocked",
    reason: "active_turn"
  });

  const interaction: AgentActivityInteraction = {
    agentSessionId: "session-1",
    createdAtUnixMs: 2,
    input: {},
    kind: "question",
    metadata: {},
    requestId: "request-1",
    status: "pending",
    turnId: "turn-1",
    updatedAtUnixMs: 2
  };
  const waiting = rootEngineReducer(initial, {
    type: "session/snapshotReceived",
    sessions: [session(turn, [interaction])]
  }).state.sessionLifecycle;
  assert.deepEqual(deriveCanonicalSubmitAvailability(waiting, "session-1"), {
    state: "blocked",
    reason: "waiting"
  });

  const settled = rootEngineReducer(initial, {
    type: "session/snapshotReceived",
    sessions: [
      session(
        {
          ...turn,
          outcome: "completed",
          phase: "settled",
          settledAtUnixMs: 3,
          updatedAtUnixMs: 3
        },
        []
      )
    ]
  }).state.sessionLifecycle;
  assert.deepEqual(deriveCanonicalSubmitAvailability(settled, "session-1"), {
    state: "available"
  });
});

test("runtime availability blocks only the targeted session", () => {
  const initial = createInitialAgentSessionEngineState();
  const first = session(
    {
      ...baseTurn("session-1", "turn-1"),
      outcome: "completed",
      phase: "settled",
      settledAtUnixMs: 2
    },
    []
  );
  const second = {
    ...first,
    agentSessionId: "session-2",
    title: "Second session",
    latestTurn: {
      ...first.latestTurn!,
      agentSessionId: "session-2",
      turnId: "turn-2"
    }
  };
  let state = rootEngineReducer(initial, {
    type: "session/snapshotReceived",
    sessions: [first, second]
  }).state;

  state = rootEngineReducer(state, {
    type: "session/runtimeAvailabilityChanged",
    agentSessionId: "session-1",
    availability: {
      state: "blocked",
      reason: "transport_reconnecting"
    }
  }).state;

  assert.deepEqual(
    deriveCanonicalSubmitAvailability(state.sessionLifecycle, "session-1"),
    { state: "blocked", reason: "transport_reconnecting" }
  );
  assert.deepEqual(
    deriveCanonicalSubmitAvailability(state.sessionLifecycle, "session-2"),
    { state: "available" }
  );
});

test("Agent capability availability blocks the targeted session", () => {
  const initial = createInitialAgentSessionEngineState();
  let state = rootEngineReducer(initial, {
    type: "session/snapshotReceived",
    sessions: [
      session(
        {
          ...baseTurn("session-1", "turn-1"),
          outcome: "completed",
          phase: "settled",
          settledAtUnixMs: 2
        },
        []
      )
    ]
  }).state;

  for (const reason of [
    "agent_capability_checking",
    "agent_capability_unavailable"
  ] as const) {
    state = rootEngineReducer(state, {
      type: "session/runtimeAvailabilityChanged",
      agentSessionId: "session-1",
      availability: { state: "blocked", reason }
    }).state;

    assert.deepEqual(
      deriveCanonicalSubmitAvailability(state.sessionLifecycle, "session-1"),
      { state: "blocked", reason }
    );
  }
});

function session(
  turn: AgentActivityTurn,
  pendingInteractions: readonly AgentActivityInteraction[]
) {
  return {
    activeTurn: turn.phase === "settled" ? null : turn,
    activeTurnId: turn.phase === "settled" ? null : turn.turnId,
    agentSessionId: "session-1",
    cwd: "/workspace",
    latestTurn: turn,
    latestTurnInteractions: pendingInteractions,
    pendingInteractions,
    provider: "codex",
    title: "Session",
    updatedAtUnixMs: turn.updatedAtUnixMs,
    workspaceId: "workspace-1"
  };
}

function baseTurn(agentSessionId: string, turnId: string): AgentActivityTurn {
  return {
    agentSessionId,
    origin: "user_prompt",
    phase: "running",
    startedAtUnixMs: 1,
    turnId,
    updatedAtUnixMs: 1
  };
}
