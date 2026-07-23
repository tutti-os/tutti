import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityMessage } from "../types.ts";
import {
  createInitialSessionMessagesState,
  sessionMessagesReducer,
  type SessionMessagesReducerContext
} from "./sessionMessages.reducer.ts";

function message(
  overrides: Partial<AgentActivityMessage> & {
    messageId: string;
    agentSessionId: string;
  }
): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    role: "assistant",
    kind: "text",
    turnId: "turn-1",
    version: 1,
    status: null,
    payload: {},
    occurredAtUnixMs: 1,
    ...overrides
  };
}

const context: SessionMessagesReducerContext = {
  sessionsById: {
    "session-1": {
      agentSessionId: "session-1",
      provider: "codex",
      providerSessionId: "provider-1"
    }
  }
};

test("merges messages into the canonical session bucket", () => {
  const state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      messages: [message({ messageId: "m1", agentSessionId: "session-1" })]
    },
    context
  ).state;
  assert.deepEqual(
    state.messagesBySessionId["session-1"]?.map((item) => item.messageId),
    ["m1"]
  );
});

test("records an exact older-history boundary even when the page is empty", () => {
  const state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      messages: [],
      historyBoundaries: [
        { agentSessionId: "session-1", hasOlderMessages: false }
      ]
    },
    context
  ).state;

  assert.equal(state.hasOlderMessagesBySessionId["session-1"], false);
});

test("an incremental message snapshot does not overwrite the older-history boundary", () => {
  let state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      messages: [],
      historyBoundaries: [
        { agentSessionId: "session-1", hasOlderMessages: true }
      ]
    },
    context
  ).state;
  state = sessionMessagesReducer(
    state,
    {
      type: "message/snapshotReceived",
      messages: [message({ messageId: "m2", agentSessionId: "session-1" })]
    },
    context
  ).state;

  assert.equal(state.hasOlderMessagesBySessionId["session-1"], true);
});

test("a higher version replaces the existing message; a lower version is dropped", () => {
  let state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      messages: [
        message({ messageId: "m1", agentSessionId: "session-1", version: 2 })
      ]
    },
    context
  ).state;
  state = sessionMessagesReducer(
    state,
    {
      type: "message/snapshotReceived",
      messages: [
        message({ messageId: "m1", agentSessionId: "session-1", version: 1 })
      ]
    },
    context
  ).state;
  assert.equal(state.messagesBySessionId["session-1"]?.[0]?.version, 2);
});

test("folds a provider-scoped alias bucket into the canonical bucket", () => {
  let state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      // arrives before the canonical session identity is known
      messages: [message({ messageId: "m1", agentSessionId: "provider-1" })]
    },
    { sessionsById: {} }
  ).state;
  assert.ok(state.messagesBySessionId["provider-1"]);
  // once the session is known, a canonical write collapses the alias bucket
  state = sessionMessagesReducer(
    state,
    {
      type: "message/snapshotReceived",
      messages: [message({ messageId: "m2", agentSessionId: "provider-1" })]
    },
    context
  ).state;
  assert.equal(state.messagesBySessionId["provider-1"], undefined);
  assert.deepEqual(
    state.messagesBySessionId["session-1"]?.map((item) => item.messageId),
    ["m1", "m2"]
  );
});

test("session identity arrival folds an existing provider alias bucket", () => {
  let state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      messages: [message({ messageId: "m1", agentSessionId: "provider-1" })]
    },
    { sessionsById: {} }
  ).state;
  state = sessionMessagesReducer(
    state,
    {
      type: "session/upserted",
      session: {
        activeTurnId: null,
        agentSessionId: "session-1",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        providerSessionId: "provider-1",
        title: "Session",
        workspaceId: "workspace-1"
      }
    },
    context
  ).state;
  assert.equal(state.messagesBySessionId["provider-1"], undefined);
  assert.equal(
    state.messagesBySessionId["session-1"]?.[0]?.agentSessionId,
    "session-1"
  );
});

test("session identity arrival folds an existing history boundary alias", () => {
  let state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      historyBoundaries: [
        { agentSessionId: "provider-1", hasOlderMessages: false }
      ],
      messages: []
    },
    { sessionsById: {} }
  ).state;
  state = sessionMessagesReducer(
    state,
    {
      type: "session/upserted",
      session: {
        activeTurnId: null,
        agentSessionId: "session-1",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        providerSessionId: "provider-1",
        title: "Session",
        workspaceId: "workspace-1"
      }
    },
    context
  ).state;

  assert.equal(state.hasOlderMessagesBySessionId["provider-1"], undefined);
  assert.equal(state.hasOlderMessagesBySessionId["session-1"], false);
});

test("session/removed drops the session bucket", () => {
  let state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      messages: [message({ messageId: "m1", agentSessionId: "session-1" })]
    },
    context
  ).state;
  state = sessionMessagesReducer(state, {
    type: "session/removed",
    agentSessionId: "session-1"
  }).state;
  assert.equal(state.messagesBySessionId["session-1"], undefined);
});

test("session/removed drops a provider alias bucket using previous identity", () => {
  let state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      messages: [message({ messageId: "m1", agentSessionId: "provider-1" })]
    },
    { sessionsById: {} }
  ).state;
  state = sessionMessagesReducer(
    state,
    {
      type: "session/removed",
      agentSessionId: "session-1"
    },
    { previousSessionsById: context.sessionsById, sessionsById: {} }
  ).state;
  assert.equal(state.messagesBySessionId["provider-1"], undefined);
});

test("session/removed drops canonical and provider history boundaries", () => {
  let state = sessionMessagesReducer(
    createInitialSessionMessagesState(),
    {
      type: "message/snapshotReceived",
      historyBoundaries: [
        { agentSessionId: "session-1", hasOlderMessages: true },
        { agentSessionId: "provider-1", hasOlderMessages: false }
      ],
      messages: []
    },
    { sessionsById: {} }
  ).state;
  state = sessionMessagesReducer(
    state,
    {
      type: "session/removed",
      agentSessionId: "session-1"
    },
    { previousSessionsById: context.sessionsById, sessionsById: {} }
  ).state;

  assert.equal(state.hasOlderMessagesBySessionId["session-1"], undefined);
  assert.equal(state.hasOlderMessagesBySessionId["provider-1"], undefined);
});
