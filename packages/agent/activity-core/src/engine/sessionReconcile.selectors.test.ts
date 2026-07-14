import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import { selectEngineSessionReconcile } from "./sessionReconcile.selectors.ts";

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
