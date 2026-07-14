import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import {
  selectEngineSessionDeleted,
  selectWorkspaceAgentConsumerCounts,
  selectWorkspaceAgentConsumerSession
} from "./sessionLifecycle.selectors.ts";

test("deleted session selector normalizes ids and hides tombstone storage", () => {
  const state = rootEngineReducer(createInitialAgentSessionEngineState(), {
    agentSessionId: "session-1",
    type: "session/removed"
  }).state;

  assert.equal(selectEngineSessionDeleted(state, " session-1 "), true);
  assert.equal(selectEngineSessionDeleted(state, "missing"), false);
  assert.equal(selectEngineSessionDeleted(state, null), false);
});

test("consumer status is derived only from canonical turn and interaction entities", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        activeTurn: {
          agentSessionId: "session-1",
          phase: "running",
          startedAtUnixMs: 10,
          turnId: "turn-1",
          updatedAtUnixMs: 20
        },
        activeTurnId: "turn-1",
        agentSessionId: "session-1",
        cwd: "/workspace",
        pendingInteractions: [
          {
            agentSessionId: "session-1",
            createdAtUnixMs: 21,
            input: { question: "Choose an option" },
            kind: "question",
            requestId: "request-1",
            status: "pending",
            turnId: "turn-1",
            updatedAtUnixMs: 21
          }
        ],
        provider: "codex",
        title: "Canonical session",
        workspaceId: "workspace-1"
      }
    ],
    type: "session/snapshotReceived"
  }).state;

  const consumer = selectWorkspaceAgentConsumerSession(state, "session-1");
  assert.equal(consumer?.displayStatus, "waiting");
  assert.equal(consumer?.session.activeTurnId, "turn-1");
  assert.equal("status" in (consumer?.session ?? {}), false);
  assert.equal("pendingInteractions" in (consumer?.session ?? {}), false);
  assert.deepEqual(selectWorkspaceAgentConsumerCounts(state), {
    canceled: 0,
    completed: 0,
    failed: 0,
    idle: 0,
    waiting: 1,
    working: 0
  });
});
