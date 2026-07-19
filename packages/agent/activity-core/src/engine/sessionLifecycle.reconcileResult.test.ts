import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import { selectSessionAvailability } from "./sessionLifecycle.availability.ts";

test("activate command result upserts session and settles pending create in one drain", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    type: "activation/requested",
    agentSessionId: "session-1",
    agentTargetId: "local:claude-code",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 100_000,
    mode: "new",
    requestedAtUnixMs: 10,
    requestId: "activation-1",
    workspaceId: "workspace-1"
  }).state;
  assert.equal(selectSessionAvailability(state, "session-1"), "creating");

  const settled = rootEngineReducer(state, {
    type: "engine/commandResult",
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "succeeded",
    value: {
      activation: { mode: "new", status: "attached" },
      session: {
        activeTurn: null,
        activeTurnId: null,
        agentSessionId: "session-1",
        createdAtUnixMs: 20,
        cwd: "/workspace",
        latestTurn: null,
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "claude-code",
        title: "New",
        updatedAtUnixMs: 20,
        workspaceId: "workspace-1"
      }
    }
  });

  assert.equal(settled.followUpIntents?.[0]?.type, "session/upserted");
  // Apply follow-up in the same drain contract the engine uses.
  state = settled.state;
  for (const followUp of settled.followUpIntents ?? []) {
    state = rootEngineReducer(state, followUp).state;
  }
  assert.equal(
    state.pendingIntents.activationsByRequestId["activation-1"]?.status,
    "confirmed"
  );
  assert.equal(
    state.sessionLifecycle.sessionsById["session-1"]?.agentSessionId,
    "session-1"
  );
  assert.equal(selectSessionAvailability(state, "session-1"), "available");
});

test("absent reconcile during pending create leaves engine untombstoned", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    type: "activation/requested",
    agentSessionId: "session-1",
    agentTargetId: "local:claude-code",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 100_000,
    mode: "new",
    requestedAtUnixMs: 10,
    requestId: "activation-1",
    workspaceId: "workspace-1"
  }).state;
  state = rootEngineReducer(state, {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  const commandId =
    state.sessionReconcile.recordsBySessionId["session-1"]?.inFlightCommandId;
  assert.ok(commandId);
  state = rootEngineReducer(state, {
    type: "engine/commandResult",
    commandId,
    commandType: "session/reconcile",
    outcome: "succeeded",
    value: { kind: "absent" }
  }).state;
  assert.equal(
    state.sessionLifecycle.deletedSessionIds["session-1"],
    undefined
  );
  assert.equal(selectSessionAvailability(state, "session-1"), "creating");
});

test("bare session/removed without evidence does not tombstone", () => {
  let state = rootEngineReducer(createInitialAgentSessionEngineState(), {
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
  state = rootEngineReducer(state, {
    type: "session/removed",
    agentSessionId: "session-1"
  }).state;
  assert.equal(
    state.sessionLifecycle.sessionsById["session-1"]?.agentSessionId,
    "session-1"
  );
  assert.equal(
    state.sessionLifecycle.deletedSessionIds["session-1"],
    undefined
  );
});
