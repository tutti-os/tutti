import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityMessage } from "../types.ts";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import { createAgentSessionFamilySnapshotSelector } from "./sessionFamily.selectors.ts";

test("session family selector preserves unrelated root projection identity", () => {
  let state = rootEngineReducer(createInitialAgentSessionEngineState(), {
    sessions: [
      session("session-a"),
      session("session-a-child", {
        kind: "child",
        parentAgentSessionId: "session-a",
        rootAgentSessionId: "session-a"
      }),
      session("session-b")
    ],
    type: "session/snapshotReceived"
  }).state;
  state = rootEngineReducer(state, {
    messages: [
      message("message-a-1", "session-a", 1),
      message("message-a-child-1", "session-a-child", 1),
      message("message-b-1", "session-b", 1)
    ],
    type: "message/snapshotReceived"
  }).state;

  const selectA = createAgentSessionFamilySnapshotSelector("session-a");
  const selectB = createAgentSessionFamilySnapshotSelector("session-b");
  const initialA = selectA(state);
  const initialB = selectB(state);

  state = rootEngineReducer(state, {
    messages: [message("message-a-2", "session-a", 2)],
    type: "message/snapshotReceived"
  }).state;

  const updatedA = selectA(state);
  const updatedB = selectB(state);
  assert.notEqual(updatedA, initialA);
  assert.notEqual(updatedA.messagesBySessionId, initialA.messagesBySessionId);
  assert.equal(updatedB, initialB);
  assert.equal(updatedB.messagesBySessionId, initialB.messagesBySessionId);
});

test("session family selector preserves an empty unrelated message bucket", () => {
  let state = rootEngineReducer(createInitialAgentSessionEngineState(), {
    sessions: [session("session-a"), session("session-b")],
    type: "session/snapshotReceived"
  }).state;
  const selectB = createAgentSessionFamilySnapshotSelector("session-b");
  const initialB = selectB(state);

  state = rootEngineReducer(state, {
    messages: [message("message-a-1", "session-a", 1)],
    type: "message/snapshotReceived"
  }).state;

  assert.equal(selectB(state), initialB);
});

function session(
  agentSessionId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    activeTurnId: null,
    agentSessionId,
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: agentSessionId,
    workspaceId: "workspace-1",
    ...overrides
  };
}

function message(
  messageId: string,
  agentSessionId: string,
  version: number
): AgentActivityMessage {
  return {
    agentSessionId,
    kind: "text",
    messageId,
    occurredAtUnixMs: version,
    payload: { text: messageId },
    role: "assistant",
    sequence: version,
    status: null,
    turnId: "turn-1",
    version,
    workspaceId: "workspace-1"
  };
}
