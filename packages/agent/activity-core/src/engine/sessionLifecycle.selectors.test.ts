import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer,
} from "./rootReducer.ts";
import {
  selectEngineSubmitAvailability,
  selectEngineSessionDeleted,
  selectWorkspaceAgentConsumerCounts,
  selectWorkspaceAgentConsumerSession,
} from "./sessionLifecycle.selectors.ts";

test("deleted session selector normalizes ids and hides tombstone storage", () => {
  const state = rootEngineReducer(createInitialAgentSessionEngineState(), {
    agentSessionId: "session-1",
    type: "session/removed",
  }).state;

  assert.equal(selectEngineSessionDeleted(state, " session-1 "), true);
  assert.equal(selectEngineSessionDeleted(state, "missing"), false);
  assert.equal(selectEngineSessionDeleted(state, null), false);
});

test("consumer status is derived from canonical entities and engine-owned initial activation", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: [],
        },
        activeTurn: {
          agentSessionId: "session-1",
          origin: "user_prompt",
          phase: "running",
          startedAtUnixMs: 10,
          turnId: "turn-1",
          updatedAtUnixMs: 20,
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
            updatedAtUnixMs: 21,
          },
        ],
        provider: "codex",
        title: "Canonical session",
        workspaceId: "workspace-1",
      },
    ],
    type: "session/snapshotReceived",
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
    working: 0,
  });
});

test("new activation stays working between session confirmation and first canonical turn", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    content: [{ type: "text", text: "test1" }],
    cwd: "/workspace",
    expiresAtUnixMs: 1_000,
    mode: "new",
    requestedAtUnixMs: 10,
    requestId: "activation-1",
    type: "activation/requested",
    workspaceId: "workspace-1",
  }).state;
  state = rootEngineReducer(state, {
    sessions: [
      {
        activeTurnId: null,
        agentSessionId: "session-1",
        createdAtUnixMs: 20,
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        title: "test1",
        workspaceId: "workspace-1",
      },
    ],
    type: "session/snapshotReceived",
  }).state;

  assert.equal(
    selectWorkspaceAgentConsumerSession(state, "session-1")?.displayStatus,
    "working",
  );

  state = rootEngineReducer(state, {
    sessions: [
      {
        activeTurnId: null,
        agentSessionId: "session-1",
        createdAtUnixMs: 20,
        cwd: "/workspace",
        latestTurn: {
          agentSessionId: "session-1",
          origin: "user_prompt",
          outcome: "completed",
          phase: "settled",
          startedAtUnixMs: 10,
          turnId: "turn-1",
          updatedAtUnixMs: 30,
        },
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        title: "test1",
        workspaceId: "workspace-1",
      },
    ],
    type: "session/snapshotReceived",
  }).state;

  assert.equal(
    selectWorkspaceAgentConsumerSession(state, "session-1")?.displayStatus,
    "completed",
  );
});

test("new activation without initial content stays idle after session confirmation", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    cwd: "/workspace",
    expiresAtUnixMs: 1_000,
    mode: "new",
    requestedAtUnixMs: 10,
    requestId: "activation-1",
    type: "activation/requested",
    workspaceId: "workspace-1",
  }).state;
  state = rootEngineReducer(state, {
    sessions: [
      {
        activeTurnId: null,
        agentSessionId: "session-1",
        createdAtUnixMs: 20,
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        title: "",
        workspaceId: "workspace-1",
      },
    ],
    type: "session/snapshotReceived",
  }).state;

  assert.equal(
    selectWorkspaceAgentConsumerSession(state, "session-1")?.displayStatus,
    "idle",
  );
});

test("completed Claude goal does not unlock a waiting root with a running child", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    sessions: [
      {
        activeTurn: {
          agentSessionId: "root",
          origin: "user_prompt",
          phase: "waiting",
          startedAtUnixMs: 10,
          turnId: "root-turn",
          updatedAtUnixMs: 30,
        },
        activeTurnId: "root-turn",
        agentSessionId: "root",
        cwd: "/workspace",
        goal: { objective: "ship it", status: "complete" },
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "claude-code",
        title: "Root",
        workspaceId: "workspace-1",
      },
      {
        activeTurn: {
          agentSessionId: "child",
          origin: "provider_initiated",
          phase: "running",
          startedAtUnixMs: 20,
          turnId: "child-turn",
          updatedAtUnixMs: 30,
        },
        activeTurnId: "child-turn",
        agentSessionId: "child",
        cwd: "/workspace",
        kind: "child",
        latestTurnInteractions: [],
        parentAgentSessionId: "root",
        parentToolCallId: "toolu-1",
        parentTurnId: "root-turn",
        pendingInteractions: [],
        provider: "claude-code",
        rootAgentSessionId: "root",
        rootTurnId: "root-turn",
        title: "Child",
        workspaceId: "workspace-1",
      },
    ],
    type: "session/snapshotReceived",
  }).state;

  assert.equal(
    selectWorkspaceAgentConsumerSession(state, "root")?.displayStatus,
    "waiting",
  );
  assert.deepEqual(selectEngineSubmitAvailability(state, "root"), {
    state: "blocked",
    reason: "active_turn",
  });
  assert.deepEqual(selectWorkspaceAgentConsumerCounts(state), {
    canceled: 0,
    completed: 0,
    failed: 0,
    idle: 0,
    waiting: 1,
    working: 0,
  });
});

test("new goal control activation stays idle without a provider Turn", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    agentSessionId: "session-goal",
    agentTargetId: "local:claude-code",
    clientSubmitId: "submit-goal",
    content: [{ type: "text", text: "/goal ship it" }],
    cwd: "/workspace",
    expiresAtUnixMs: 1_000,
    initialTurnExpected: false,
    mode: "new",
    requestedAtUnixMs: 10,
    requestId: "activation-goal",
    runtimeContent: [{ type: "text", text: "/goal ship it" }],
    type: "activation/requested",
    workspaceId: "workspace-1",
  }).state;
  state = rootEngineReducer(state, {
    sessions: [
      {
        activeTurnId: null,
        agentSessionId: "session-goal",
        createdAtUnixMs: 20,
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "claude-code",
        title: "/goal ship it",
        workspaceId: "workspace-1",
      },
    ],
    type: "session/snapshotReceived",
  }).state;

  assert.equal(
    selectWorkspaceAgentConsumerSession(state, "session-goal")?.displayStatus,
    "idle",
  );
});
