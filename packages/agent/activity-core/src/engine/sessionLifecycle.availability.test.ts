import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityInteraction, AgentActivityTurn } from "../types.ts";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import {
  deriveCanonicalSubmitAvailability,
  selectSessionAvailability
} from "./sessionLifecycle.availability.ts";

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

test("session availability covers creating, missing, deleted, and available", () => {
  let state = createInitialAgentSessionEngineState();
  assert.equal(selectSessionAvailability(state, "session-1"), "missing");

  state = rootEngineReducer(state, {
    type: "activation/requested",
    agentSessionId: "session-1",
    agentTargetId: "local:claude-code",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 100_000,
    mode: "new",
    requestedAtUnixMs: 1,
    requestId: "activation-1",
    workspaceId: "workspace-1"
  }).state;
  assert.equal(selectSessionAvailability(state, "session-1"), "creating");

  state = rootEngineReducer(state, {
    type: "session/removed",
    agentSessionId: "session-1",
    evidence: {
      source: "session_deleted_event",
      deletedAtUnixMs: 2
    }
  }).state;
  assert.equal(selectSessionAvailability(state, "session-1"), "deleted");

  state = rootEngineReducer(createInitialAgentSessionEngineState(), {
    type: "session/upserted",
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
  }).state;
  assert.equal(selectSessionAvailability(state, "session-1"), "available");
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
