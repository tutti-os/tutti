import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionReadStateReducer,
  createInitialAttentionReadState
} from "./attentionReadState.reducer.ts";

const turn = {
  turnId: "turn-1",
  agentSessionId: "session-1",
  phase: "settled" as const,
  outcome: "completed" as const,
  startedAtUnixMs: 1,
  settledAtUnixMs: 2,
  updatedAtUnixMs: 2
};

test("a live canonical completion becomes unread and read intent clears it", () => {
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    {
      type: "turn/upserted",
      turn
    },
    { sessionsById: { "session-1": { userId: "user-1" } }, turnsById: {} }
  ).state;
  assert.deepEqual(
    state.partitionsByUserId["user-1"]?.recordsBySessionId["session-1"],
    {
      completionKey: "turn:session-1:turn-1:completed",
      isUnread: true,
      kind: "completed"
    }
  );
  state = attentionReadStateReducer(state, {
    type: "attention/read",
    agentSessionId: "session-1",
    userId: "user-1"
  }).state;
  assert.equal(
    state.partitionsByUserId["user-1"]?.recordsBySessionId["session-1"]
      ?.isUnread,
    false
  );
});

test("historical snapshot completion stays read unless persistence says unread", () => {
  const initial = attentionReadStateReducer(createInitialAttentionReadState(), {
    type: "session/snapshotReceived",
    sessions: [
      {
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        provider: "codex",
        cwd: "/workspace",
        title: "Session",
        userId: "user-1",
        activeTurnId: null,
        activeTurn: null,
        latestTurn: turn
      }
    ]
  }).state;
  assert.equal(
    initial.partitionsByUserId["user-1"]?.recordsBySessionId["session-1"]
      ?.isUnread,
    false
  );
  let hydrated = attentionReadStateReducer(createInitialAttentionReadState(), {
    type: "attention/readStateHydrated",
    userId: "user-1",
    completed: { readIds: [], unreadIds: ["session-1"] },
    failed: { readIds: [], unreadIds: [] }
  }).state;
  hydrated = attentionReadStateReducer(hydrated, {
    type: "session/snapshotReceived",
    sessions: [
      {
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        provider: "codex",
        cwd: "/workspace",
        title: "Session",
        userId: "user-1",
        activeTurnId: null,
        activeTurn: null,
        latestTurn: turn
      }
    ]
  }).state;
  assert.equal(
    hydrated.partitionsByUserId["user-1"]?.recordsBySessionId["session-1"]
      ?.isUnread,
    true
  );
});

test("late hydration authoritatively clears an already observed unread completion", () => {
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    {
      type: "turn/upserted",
      turn
    },
    { sessionsById: { "session-1": { userId: "user-1" } }, turnsById: {} }
  ).state;
  state = attentionReadStateReducer(state, {
    type: "attention/readStateHydrated",
    userId: "user-1",
    completed: { readIds: ["session-1"], unreadIds: [] },
    failed: { readIds: [], unreadIds: [] }
  }).state;
  assert.equal(
    state.partitionsByUserId["user-1"]?.recordsBySessionId["session-1"]
      ?.isUnread,
    false
  );
});

test("read intent without an observed completion does not invent attention", () => {
  const state = attentionReadStateReducer(createInitialAttentionReadState(), {
    type: "attention/read",
    agentSessionId: "session-1",
    userId: "user-1"
  }).state;
  assert.equal(state.partitionsByUserId["user-1"], undefined);
});

test("read state is isolated between users in one workspace engine", () => {
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { type: "turn/upserted", turn },
    { sessionsById: { "session-1": { userId: "user-1" } }, turnsById: {} }
  ).state;
  state = attentionReadStateReducer(state, {
    type: "attention/read",
    agentSessionId: "session-1",
    userId: "user-1"
  }).state;
  state = attentionReadStateReducer(state, {
    type: "attention/readStateHydrated",
    userId: "user-2",
    completed: { readIds: [], unreadIds: ["session-1"] },
    failed: { readIds: [], unreadIds: [] }
  }).state;
  assert.equal(
    state.partitionsByUserId["user-1"]?.recordsBySessionId["session-1"]
      ?.isUnread,
    false
  );
  assert.equal(
    state.partitionsByUserId["user-2"]?.recordsBySessionId["session-1"],
    undefined
  );
});

test("reading one observed session preserves hydrated ids for unloaded sessions", () => {
  let state = attentionReadStateReducer(createInitialAttentionReadState(), {
    type: "attention/readStateHydrated",
    userId: "user-1",
    completed: { readIds: ["historical-read"], unreadIds: ["session-1"] },
    failed: { readIds: [], unreadIds: ["historical-failed"] }
  }).state;
  state = attentionReadStateReducer(
    state,
    { type: "turn/upserted", turn },
    {
      sessionsById: { "session-1": { userId: "user-1" } },
      turnsById: {}
    }
  ).state;
  state = attentionReadStateReducer(state, {
    type: "attention/read",
    agentSessionId: "session-1",
    userId: "user-1"
  }).state;
  const hydrated = state.partitionsByUserId["user-1"]?.hydrated;
  assert.deepEqual(hydrated?.completedReadIds, [
    "historical-read",
    "session-1"
  ]);
  assert.deepEqual(hydrated?.failedUnreadIds, ["historical-failed"]);
});

test("a turn that arrives before its session is replayed when user ownership arrives", () => {
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { type: "turn/upserted", turn },
    { sessionsById: {}, turnsById: { turn: turn } }
  ).state;
  assert.deepEqual(state.partitionsByUserId, {});
  state = attentionReadStateReducer(
    state,
    {
      type: "session/upserted",
      session: {
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        userId: "user-1",
        provider: "codex",
        cwd: "/workspace",
        title: "Session"
      }
    },
    {
      sessionsById: { "session-1": { userId: "user-1" } },
      turnsById: { turn: turn }
    }
  ).state;
  assert.equal(
    state.partitionsByUserId["user-1"]?.recordsBySessionId["session-1"]
      ?.isUnread,
    true
  );
});

test("a settled latest turn on a session upsert is historical until persistence says unread", () => {
  const state = attentionReadStateReducer(createInitialAttentionReadState(), {
    type: "session/upserted",
    session: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      userId: "user-1",
      provider: "codex",
      cwd: "/workspace",
      title: "Session",
      activeTurnId: null,
      activeTurn: null,
      latestTurn: turn
    }
  }).state;
  assert.equal(
    state.partitionsByUserId["user-1"]?.recordsBySessionId["session-1"]
      ?.isUnread,
    false
  );
});

test("hydration and writes cross the engine command port without dropping unloaded ids", () => {
  let result = attentionReadStateReducer(createInitialAttentionReadState(), {
    type: "attention/hydrateRequested",
    commandId: "read-1",
    userId: "user-1",
    workspaceId: "workspace-1"
  });
  assert.deepEqual(result.commands, [
    {
      type: "attention/readState/read",
      commandId: "read-1",
      correlationId: "user-1",
      userId: "user-1",
      workspaceId: "workspace-1"
    }
  ]);
  result = attentionReadStateReducer(result.state, {
    type: "engine/commandResult",
    commandId: "read-1",
    commandType: "attention/readState/read",
    correlationId: "user-1",
    outcome: "succeeded",
    value: {
      completed: { readIds: ["historical"], unreadIds: ["session-1"] },
      failed: { readIds: [], unreadIds: ["failed-historical"] }
    }
  });
  result = attentionReadStateReducer(
    result.state,
    { type: "turn/upserted", turn },
    {
      sessionsById: { "session-1": { userId: "user-1" } },
      turnsById: {}
    }
  );
  assert.equal(result.commands[0]?.type, "attention/readState/write");
  result = attentionReadStateReducer(result.state, {
    type: "engine/commandResult",
    commandId: "attention-write:user-1:1",
    commandType: "attention/readState/write",
    correlationId: "user-1",
    outcome: "succeeded"
  });
  result = attentionReadStateReducer(result.state, {
    type: "attention/read",
    agentSessionId: "session-1",
    userId: "user-1"
  });
  assert.deepEqual(result.commands, [
    {
      type: "attention/readState/write",
      commandId: "attention-write:user-1:2",
      correlationId: "user-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      completed: {
        readIds: ["historical", "session-1"],
        unreadIds: []
      },
      failed: { readIds: [], unreadIds: ["failed-historical"] }
    }
  ]);
});

test("a completion observed before empty hydration is merged and persisted", () => {
  let result = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { type: "turn/upserted", turn },
    {
      sessionsById: { "session-1": { userId: "user-1" } },
      turnsById: {}
    }
  );
  result = attentionReadStateReducer(result.state, {
    type: "attention/hydrateRequested",
    commandId: "read-1",
    userId: "user-1",
    workspaceId: "workspace-1"
  });
  result = attentionReadStateReducer(result.state, {
    type: "engine/commandResult",
    commandId: "read-1",
    commandType: "attention/readState/read",
    correlationId: "user-1",
    outcome: "succeeded",
    value: {
      completed: { readIds: [], unreadIds: [] },
      failed: { readIds: [], unreadIds: [] }
    }
  });
  assert.deepEqual(result.commands, [
    {
      type: "attention/readState/write",
      commandId: "attention-write:user-1:1",
      correlationId: "user-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      completed: { readIds: [], unreadIds: ["session-1"] },
      failed: { readIds: [], unreadIds: [] }
    }
  ]);
});

test("rapid attention changes serialize full snapshot writes", () => {
  let result = attentionReadStateReducer(createInitialAttentionReadState(), {
    type: "attention/hydrateRequested",
    commandId: "read-1",
    userId: "user-1",
    workspaceId: "workspace-1"
  });
  result = attentionReadStateReducer(result.state, {
    type: "engine/commandResult",
    commandId: "read-1",
    commandType: "attention/readState/read",
    correlationId: "user-1",
    outcome: "succeeded",
    value: {
      completed: { readIds: [], unreadIds: [] },
      failed: { readIds: [], unreadIds: [] }
    }
  });
  result = attentionReadStateReducer(
    result.state,
    { type: "turn/upserted", turn },
    {
      sessionsById: { "session-1": { userId: "user-1" } },
      turnsById: {}
    }
  );
  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["attention/readState/write"]
  );
  result = attentionReadStateReducer(result.state, {
    type: "attention/read",
    agentSessionId: "session-1",
    userId: "user-1"
  });
  assert.deepEqual(result.commands, []);
  result = attentionReadStateReducer(result.state, {
    type: "engine/commandResult",
    commandId: "attention-write:user-1:1",
    commandType: "attention/readState/write",
    correlationId: "user-1",
    outcome: "succeeded"
  });
  assert.deepEqual(result.commands, [
    {
      type: "attention/readState/write",
      commandId: "attention-write:user-1:2",
      correlationId: "user-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      completed: { readIds: ["session-1"], unreadIds: [] },
      failed: { readIds: [], unreadIds: [] }
    }
  ]);
  const stateBeforeLateResult = result.state;
  result = attentionReadStateReducer(result.state, {
    type: "engine/commandResult",
    commandId: "attention-write:user-1:1",
    commandType: "attention/readState/write",
    correlationId: "user-1",
    outcome: "succeeded"
  });
  assert.equal(result.state, stateBeforeLateResult);
});

test("write failure is visible and an explicit retry emits the latest snapshot", () => {
  let result = attentionReadStateReducer(createInitialAttentionReadState(), {
    type: "attention/hydrateRequested",
    commandId: "read-1",
    userId: "user-1",
    workspaceId: "workspace-1"
  });
  result = attentionReadStateReducer(result.state, {
    type: "engine/commandResult",
    commandId: "read-1",
    commandType: "attention/readState/read",
    correlationId: "user-1",
    outcome: "succeeded",
    value: {
      completed: { readIds: [], unreadIds: [] },
      failed: { readIds: [], unreadIds: [] }
    }
  });
  result = attentionReadStateReducer(
    result.state,
    { type: "turn/upserted", turn },
    {
      sessionsById: { "session-1": { userId: "user-1" } },
      turnsById: {}
    }
  );
  result = attentionReadStateReducer(result.state, {
    type: "engine/commandResult",
    commandId: "attention-write:user-1:1",
    commandType: "attention/readState/write",
    correlationId: "user-1",
    errorMessage: "disk full",
    outcome: "failed"
  });
  assert.equal(
    result.state.partitionsByUserId["user-1"]?.lastError,
    "disk full"
  );
  result = attentionReadStateReducer(result.state, {
    type: "attention/persistRetryRequested",
    userId: "user-1"
  });
  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["attention/readState/write"]
  );
});
