import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import {
  selectEngineSessionDetailHydrated,
  selectEngineSessionDetailLoading,
  selectEngineSessionReconcile
} from "./sessionReconcile.selectors.ts";

test("session reconcile selector normalizes ids and hides reducer storage", () => {
  const state = rootEngineReducer(createInitialAgentSessionEngineState(), {
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: true,
    type: "session/reconcileRequested",
    workspaceId: "workspace-1"
  }).state;

  assert.equal(
    selectEngineSessionReconcile(state, " session-1 ")?.inFlightCommandId,
    "session:reconcile:session-1:1"
  );
  assert.equal(selectEngineSessionReconcile(state, "missing"), null);
  assert.equal(selectEngineSessionReconcile(state, "  "), null);
});

test("successful message reconcile keeps later refreshes non-blocking", () => {
  let state = rootEngineReducer(createInitialAgentSessionEngineState(), {
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: true,
    type: "session/reconcileRequested",
    workspaceId: "workspace-1"
  }).state;

  assert.equal(selectEngineSessionDetailHydrated(state, "session-1"), false);
  assert.equal(selectEngineSessionDetailLoading(state, "session-1"), true);

  state = rootEngineReducer(state, {
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "succeeded",
    type: "engine/commandResult"
  }).state;
  assert.equal(selectEngineSessionDetailHydrated(state, "session-1"), true);
  assert.equal(selectEngineSessionDetailLoading(state, "session-1"), false);

  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: true,
    type: "session/reconcileRequested",
    workspaceId: "workspace-1"
  }).state;
  assert.equal(selectEngineSessionDetailLoading(state, "session-1"), false);
});

test("state-only reconcile does not block conversation detail", () => {
  const state = rootEngineReducer(createInitialAgentSessionEngineState(), {
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    type: "session/reconcileRequested",
    workspaceId: "workspace-1"
  }).state;

  assert.equal(selectEngineSessionDetailHydrated(state, "session-1"), false);
  assert.equal(selectEngineSessionDetailLoading(state, "session-1"), false);
});
