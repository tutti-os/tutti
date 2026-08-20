import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionReadStateReducer,
  createInitialAttentionReadState
} from "./attentionReadState.reducer.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";
import type { AgentActivityTurn } from "../types.ts";

const turn = {
  turnId: "turn-1",
  agentSessionId: "session-1",
  origin: "user_prompt" as const,
  phase: "settled" as const,
  outcome: "completed" as const,
  startedAtUnixMs: 1,
  settledAtUnixMs: 2,
  updatedAtUnixMs: 2
};

function acceptedTurnContext(
  turns: readonly AgentActivityTurn[],
  options: { includePrevious?: boolean } = {}
) {
  return {
    previousSessionsById: {},
    previousTurnsById: Object.fromEntries(
      options.includePrevious === false
        ? []
        : turns.map((item) => [
            canonicalTurnKey(item.agentSessionId, item.turnId),
            item
          ])
    ),
    sessionsById: { "session-1": { userId: "user-1" } },
    turnsById: Object.fromEntries(
      turns.map((item) => [
        canonicalTurnKey(item.agentSessionId, item.turnId),
        item
      ])
    )
  };
}

function liveTurn(turns: readonly AgentActivityTurn[]) {
  return acceptedTurnContext(turns, { includePrevious: false });
}

function hydrate(
  state: ReturnType<typeof createInitialAttentionReadState>,
  value: {
    completed?: { readIds?: string[]; unreadIds?: string[] };
    failed?: { readIds?: string[]; unreadIds?: string[] };
  } = {}
) {
  return attentionReadStateReducer(state, {
    type: "attention/readStateHydrated",
    userId: "user-1",
    completed: {
      readIds: value.completed?.readIds ?? [],
      unreadIds: value.completed?.unreadIds ?? []
    },
    failed: {
      readIds: value.failed?.readIds ?? [],
      unreadIds: value.failed?.unreadIds ?? []
    }
  }).state;
}

function read(state: ReturnType<typeof createInitialAttentionReadState>) {
  return attentionReadStateReducer(state, {
    type: "attention/read",
    agentSessionId: "session-1",
    userId: "user-1"
  }).state;
}

function unread(state: ReturnType<typeof createInitialAttentionReadState>) {
  return attentionReadStateReducer(
    state,
    {
      type: "attention/unreadRequested",
      agentSessionId: "session-1",
      userId: "user-1"
    },
    acceptedTurnContext([turn])
  ).state;
}

function hydrateThroughCommand(value: Parameters<typeof hydrate>[1] = {}) {
  let result = attentionReadStateReducer(createInitialAttentionReadState(), {
    commandId: "read-1",
    type: "attention/hydrateRequested",
    userId: "user-1",
    workspaceId: "workspace-1"
  });
  const commandResult = {
    commandId: "read-1",
    commandType: "attention/readState/read",
    correlationId: "user-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      completed: {
        readIds: value.completed?.readIds ?? [],
        unreadIds: value.completed?.unreadIds ?? []
      },
      failed: {
        readIds: value.failed?.readIds ?? [],
        unreadIds: value.failed?.unreadIds ?? []
      }
    }
  } as const;
  result = attentionReadStateReducer(result.state, commandResult);
  return result;
}

function record(state: ReturnType<typeof createInitialAttentionReadState>) {
  return state.partitionsByUserId["user-1"]?.recordsBySessionId["session-1"];
}

test("a live completion creates unread and read removes the unread record", () => {
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
  ).state;
  assert.deepEqual(record(state), {
    completionKey: "turn:session-1:turn-1:completed",
    isUnread: true,
    kind: "completed",
    markedUnreadByUser: false,
    observationProvenance: "live",
    readStateProvenance: "live"
  });

  state = read(state);
  assert.equal(record(state), undefined);

  // A replay of an already settled canonical Turn is not a new completion.
  state = attentionReadStateReducer(
    state,
    { live: true, type: "turn/upserted", turn },
    acceptedTurnContext([turn])
  ).state;
  assert.equal(record(state), undefined);
});

test("an omitted live flag remains live for older hosts", () => {
  const state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { type: "turn/upserted", turn },
    liveTurn([turn])
  ).state;
  assert.equal(record(state)?.isUnread, true);
});

test("historical turns never create or mutate attention state", () => {
  let state = hydrate(createInitialAttentionReadState());
  state = attentionReadStateReducer(
    state,
    { live: false, type: "turn/upserted", turn },
    acceptedTurnContext([turn], { includePrevious: false })
  ).state;
  assert.equal(record(state), undefined);
  assert.deepEqual(
    state.partitionsByUserId["user-1"]?.hydrated?.completedReadIds,
    []
  );
});

test("a stale list snapshot cannot remove a live unread completion", () => {
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
  ).state;
  const oldTurn = { ...turn, turnId: "turn-old", updatedAtUnixMs: 1 };
  state = attentionReadStateReducer(
    state,
    {
      sessions: [{ ...authoritativeSession(), latestTurn: oldTurn }],
      type: "session/snapshotReceived"
    },
    {
      previousSessionsById: { "session-1": {} as never },
      previousTurnsById: {
        [canonicalTurnKey("session-1", turn.turnId)]: turn
      },
      sessionsById: { "session-1": { userId: "user-1" } },
      turnsById: { [canonicalTurnKey("session-1", oldTurn.turnId)]: oldTurn }
    }
  ).state;
  assert.equal(record(state)?.completionKey, "turn:session-1:turn-1:completed");
});

test("authoritative history omission preserves live unread attention", () => {
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
  ).state;
  state = attentionReadStateReducer(state, {
    agentSessionId: "session-1",
    childSessions: [],
    historyRevision: 1,
    messages: [],
    session: authoritativeSession(),
    turns: [],
    type: "session/historyAuthoritativeSnapshotReceived",
    workspaceId: "workspace-1"
  }).state;
  assert.equal(record(state)?.isUnread, true);

  state = attentionReadStateReducer(
    state,
    {
      sessions: [{ ...authoritativeSession(), latestTurn: turn }],
      type: "session/snapshotReceived"
    },
    acceptedTurnContext([turn])
  ).state;
  assert.equal(record(state)?.isUnread, true);
});

test("a live detail snapshot can replay a completion once identity arrives", () => {
  const state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    {
      live: true,
      replayAcceptedLiveCompletion: true,
      turn,
      type: "turn/upserted"
    },
    acceptedTurnContext([turn], { includePrevious: false })
  ).state;
  assert.equal(record(state)?.isUnread, true);
});

test("normalizes canonical turn session ids before looking up the user", () => {
  const paddedTurn = { ...turn, agentSessionId: " session-1 " };
  const state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { live: true, type: "turn/upserted", turn: paddedTurn },
    liveTurn([paddedTurn])
  ).state;

  assert.equal(record(state)?.completionKey, "turn:session-1:turn-1:completed");
});

test("an authoritative history live turn marker creates unread atomically", () => {
  const state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    {
      live: true,
      replayAcceptedLiveCompletion: true,
      turn,
      type: "turn/upserted"
    },
    acceptedTurnContext([turn], { includePrevious: false })
  ).state;
  assert.equal(record(state)?.isUnread, true);
});

test("a historical session can be manually marked unread from canonical turns", () => {
  const state = unread(createInitialAttentionReadState());
  assert.deepEqual(record(state), {
    completionKey: "turn:session-1:turn-1:completed",
    isUnread: true,
    kind: "completed",
    markedUnreadByUser: true,
    observationProvenance: "live",
    readStateProvenance: "durable"
  });
});

test("manual unread uses the newest canonical turn when latestTurn is omitted", () => {
  const olderTurn = {
    ...turn,
    turnId: "turn-old",
    startedAtUnixMs: 1,
    updatedAtUnixMs: 2
  };
  const newerTurn = {
    ...turn,
    turnId: "turn-new",
    startedAtUnixMs: 3,
    updatedAtUnixMs: 4
  };
  const state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    {
      type: "attention/unreadRequested",
      agentSessionId: "session-1",
      userId: "user-1"
    },
    acceptedTurnContext([olderTurn, newerTurn])
  ).state;

  assert.equal(
    record(state)?.completionKey,
    "turn:session-1:turn-new:completed"
  );
});

test("a new live completion re-lights an already read session", () => {
  const turn2 = { ...turn, turnId: "turn-2", updatedAtUnixMs: 4 };
  let state = hydrate(createInitialAttentionReadState());
  state = attentionReadStateReducer(
    state,
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
  ).state;
  state = read(state);
  assert.equal(record(state), undefined);
  state = attentionReadStateReducer(
    state,
    { live: true, type: "turn/upserted", turn: turn2 },
    acceptedTurnContext([turn, turn2], { includePrevious: false })
  ).state;
  assert.equal(record(state)?.completionKey, "turn:session-1:turn-2:completed");
});

test("a live completion outcome change replaces the unread completion", () => {
  const failedTurn = { ...turn, outcome: "failed" as const };
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
  ).state;
  assert.equal(record(state)?.kind, "completed");

  state = attentionReadStateReducer(
    state,
    { live: true, type: "turn/upserted", turn: failedTurn },
    {
      previousSessionsById: {},
      previousTurnsById: {
        [canonicalTurnKey("session-1", turn.turnId)]: turn
      },
      sessionsById: { "session-1": { userId: "user-1" } },
      turnsById: { [canonicalTurnKey("session-1", turn.turnId)]: failedTurn }
    }
  ).state;
  assert.deepEqual(record(state), {
    completionKey: "turn:session-1:turn-1:failed",
    isUnread: true,
    kind: "failed",
    markedUnreadByUser: false,
    observationProvenance: "live",
    readStateProvenance: "live"
  });
});

test("hydration restores persisted unread records and ignores legacy read markers", () => {
  let state = hydrate(createInitialAttentionReadState(), {
    completed: {
      readIds: [
        "turn:other-read:turn-read:completed",
        "turn:session-1:turn-1:completed"
      ],
      unreadIds: ["turn:session-1:turn-1:completed"]
    },
    failed: { readIds: ["turn:other-failed:turn-9:failed"] }
  });
  assert.equal(record(state)?.isUnread, true);
  assert.equal(
    state.partitionsByUserId["user-1"]?.hydrated?.completedReadIds.length,
    0
  );
  assert.deepEqual(
    state.partitionsByUserId["user-1"]?.hydrated?.completedUnreadIds,
    ["turn:session-1:turn-1:completed"]
  );

  state = read(state);
  assert.equal(record(state), undefined);
  assert.deepEqual(
    state.partitionsByUserId["user-1"]?.hydrated?.completedUnreadIds,
    []
  );
});

test("late legacy read hydration cannot clear a live unread completion", () => {
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
  ).state;
  state = hydrate(state, {
    completed: { readIds: ["turn:session-1:turn-1:completed"] }
  });
  assert.deepEqual(record(state), {
    completionKey: "turn:session-1:turn-1:completed",
    isUnread: true,
    kind: "completed",
    markedUnreadByUser: false,
    observationProvenance: "live",
    readStateProvenance: "live"
  });
});

test("a completion observed before empty hydration remains unread", () => {
  let state = attentionReadStateReducer(
    createInitialAttentionReadState(),
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
  ).state;
  state = hydrate(state);
  assert.equal(record(state)?.isUnread, true);
  assert.deepEqual(
    state.partitionsByUserId["user-1"]?.hydrated?.completedUnreadIds,
    ["turn:session-1:turn-1:completed"]
  );
});

test("manual unread before hydration is persisted after hydration completes", () => {
  let result = attentionReadStateReducer(createInitialAttentionReadState(), {
    commandId: "read-1",
    type: "attention/hydrateRequested",
    userId: "user-1",
    workspaceId: "workspace-1"
  });
  result = attentionReadStateReducer(
    result.state,
    {
      type: "attention/unreadRequested",
      agentSessionId: "session-1",
      userId: "user-1"
    },
    acceptedTurnContext([turn])
  );
  assert.deepEqual(result.commands, []);

  result = attentionReadStateReducer(result.state, {
    type: "attention/readStateHydrated",
    userId: "user-1",
    completed: { readIds: [], unreadIds: [] },
    failed: { readIds: [], unreadIds: [] }
  });

  assert.deepEqual(result.commands, [
    {
      type: "attention/readState/write",
      commandId: "attention-write:user-1:1",
      correlationId: "user-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      completed: {
        readIds: [],
        unreadIds: ["turn:session-1:turn-1:completed"]
      },
      failed: { readIds: [], unreadIds: [] }
    }
  ]);
});

test("session removal deletes its durable unread key", () => {
  let state = hydrate(createInitialAttentionReadState(), {
    completed: { unreadIds: ["turn:session-1:turn-1:completed"] },
    failed: { unreadIds: ["turn:other:turn-8:failed"] }
  });
  state = attentionReadStateReducer(state, {
    agentSessionId: "session-1",
    type: "session/removed"
  }).state;
  assert.equal(record(state), undefined);
  assert.deepEqual(
    state.partitionsByUserId["user-1"]?.hydrated?.completedUnreadIds,
    []
  );
  assert.deepEqual(
    state.partitionsByUserId["user-1"]?.hydrated?.failedUnreadIds,
    ["turn:other:turn-8:failed"]
  );
});

test("unread request for a removed session is ignored", () => {
  let state = hydrate(createInitialAttentionReadState(), {
    completed: { unreadIds: ["turn:session-1:turn-1:completed"] }
  });
  state = attentionReadStateReducer(state, {
    agentSessionId: "session-1",
    type: "session/removed"
  }).state;
  state = attentionReadStateReducer(
    state,
    {
      type: "attention/unreadRequested",
      agentSessionId: "session-1",
      userId: "user-1"
    },
    {
      ...acceptedTurnContext([turn]),
      sessionsById: {}
    }
  ).state;
  assert.equal(record(state), undefined);
});

test("persistence preserves unrelated unread keys and clears read buckets", () => {
  let result = hydrateThroughCommand({
    completed: { unreadIds: ["turn:other:turn-9:completed"] },
    failed: { unreadIds: ["turn:other-b:turn-8:failed"] }
  });
  result = attentionReadStateReducer(
    result.state,
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
  );
  assert.equal(result.commands[0]?.type, "attention/readState/write");
  assert.deepEqual(result.commands[0], {
    type: "attention/readState/write",
    commandId: "attention-write:user-1:1",
    correlationId: "user-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    completed: {
      readIds: [],
      unreadIds: [
        "turn:other:turn-9:completed",
        "turn:session-1:turn-1:completed"
      ]
    },
    failed: {
      readIds: [],
      unreadIds: ["turn:other-b:turn-8:failed"]
    }
  });

  result = attentionReadStateReducer(result.state, {
    type: "attention/read",
    agentSessionId: "session-1",
    userId: "user-1"
  });
  assert.deepEqual(result.commands, []);
  const hydrated = result.state.partitionsByUserId["user-1"]?.hydrated;
  assert.deepEqual(hydrated?.completedUnreadIds, [
    "turn:other:turn-9:completed"
  ]);
});

test("rapid attention changes serialize full snapshot writes", () => {
  let result = hydrateThroughCommand();
  result = attentionReadStateReducer(
    result.state,
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
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
    commandId: "attention-write:user-1:1",
    commandType: "attention/readState/write",
    correlationId: "user-1",
    outcome: "succeeded",
    type: "engine/commandResult"
  });
  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["attention/readState/write"]
  );
  assert.deepEqual(result.commands[0], {
    type: "attention/readState/write",
    commandId: "attention-write:user-1:2",
    correlationId: "user-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    completed: { readIds: [], unreadIds: [] },
    failed: { readIds: [], unreadIds: [] }
  });
});

test("write failure is visible and retry emits the latest unread-only snapshot", () => {
  let result = hydrateThroughCommand();
  result = attentionReadStateReducer(
    result.state,
    { live: true, type: "turn/upserted", turn },
    liveTurn([turn])
  );
  result = attentionReadStateReducer(result.state, {
    commandId: "attention-write:user-1:1",
    commandType: "attention/readState/write",
    correlationId: "user-1",
    errorMessage: "disk full",
    outcome: "failed",
    type: "engine/commandResult"
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
  const writeCommand = result.commands[0];
  assert.equal(writeCommand?.type, "attention/readState/write");
  if (writeCommand?.type !== "attention/readState/write") return;
  assert.deepEqual(writeCommand.completed, {
    readIds: [],
    unreadIds: ["turn:session-1:turn-1:completed"]
  });
});

function authoritativeSession() {
  return {
    activeTurn: null,
    activeTurnId: null,
    agentSessionId: "session-1",
    agentTargetId: null,
    capabilities: null,
    createdAtUnixMs: 1,
    cwd: "/workspace",
    endedAtUnixMs: null,
    goal: null,
    imported: false,
    kind: "root" as const,
    lastEventUnixMs: 2,
    latestTurn: null,
    latestTurnInteractions: [],
    messageVersion: 1,
    parentAgentSessionId: null,
    parentToolCallId: null,
    parentTurnId: null,
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    resumable: true,
    rootAgentSessionId: null,
    rootTurnId: null,
    settings: {},
    startedAtUnixMs: 1,
    title: "Session",
    tuttiModeActivation: null,
    updatedAtUnixMs: 2,
    usage: null,
    visible: true,
    workspaceId: "workspace-1"
  };
}
