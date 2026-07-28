import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialSessionReconcileState,
  sessionReconcileReducer
} from "./sessionReconcile.reducer.ts";

test("activity observation derives reconcile scope inside the engine", () => {
  const result = reduce(createInitialSessionReconcileState(), {
    type: "session/activityObserved",
    agentSessionId: "session-1",
    eventType: "message_update",
    hasCachedSession: true,
    hasInlineMessages: false,
    inlineApplied: false,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(result.commands, [
    {
      agentSessionId: "session-1",
      commandId: "session:reconcile:session-1:1",
      live: false,
      scope: "state_and_messages",
      timeoutMs: 30_000,
      type: "session/reconcile",
      workspaceId: "workspace-1"
    }
  ]);
});

test("inline-applied activity does not schedule redundant transport work", () => {
  const result = reduce(createInitialSessionReconcileState(), {
    type: "session/activityObserved",
    agentSessionId: "session-1",
    eventType: "turn_update",
    hasCachedSession: true,
    hasInlineMessages: false,
    inlineApplied: true,
    workspaceId: "workspace-1"
  });
  assert.equal(result.commands.length, 0);
});

test("reconcile requests merge while one command is in flight and rerun once", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: false,
    workspaceId: "workspace-1"
  }).state;
  const merged = reduce(state, {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  });
  assert.equal(merged.commands.length, 0);
  state = merged.state;
  const settled = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "succeeded"
  });
  assert.deepEqual(settled.commands, [
    {
      agentSessionId: "session-1",
      commandId: "session:reconcile:session-1:2",
      live: false,
      scope: "state",
      timeoutMs: 30_000,
      type: "session/reconcile",
      workspaceId: "workspace-1"
    }
  ]);
});

test("session removal discards queued reconcile demand", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  state = reduce(state, {
    type: "session/removed",
    agentSessionId: "session-1"
  }).state;
  assert.equal(state.recordsBySessionId["session-1"], undefined);
});

test("a timed-out reconcile releases merged demand into the next command", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: false,
    workspaceId: "workspace-1"
  }).state;
  state = reduce(state, {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  const timedOut = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "timedOut"
  });
  assert.equal(timedOut.commands[0]?.type, "session/reconcile");
  assert.equal(
    timedOut.commands[0]?.type === "session/reconcile"
      ? timedOut.commands[0].scope
      : null,
    "state"
  );
});

test("failed reconcile preserves typed error details for exact recovery", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  state = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    errorCode: "session.not_found",
    errorMessage: "Session not found.",
    outcome: "failed"
  }).state;

  assert.deepEqual(state.recordsBySessionId["session-1"], {
    agentSessionId: "session-1",
    errorCode: "session.not_found",
    errorMessage: "Session not found.",
    inFlightCommandId: null,
    inFlightLive: false,
    inFlightScope: null,
    messagesHydrated: false,
    pendingLive: false,
    pendingMessages: false,
    pendingState: false,
    workspaceId: "workspace-1"
  });
});

test("a later reconcile request clears stale typed error details", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;
  state = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    errorCode: "session.not_found",
    errorMessage: "Session not found.",
    outcome: "failed"
  }).state;

  const retried = reduce(state, {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  });

  assert.equal(retried.state.recordsBySessionId["session-1"]?.errorCode, null);
});

test("a merged retry does not expose the previous attempt's typed error", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: false,
    workspaceId: "workspace-1"
  }).state;
  state = reduce(state, {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: true,
    workspaceId: "workspace-1"
  }).state;

  const retrying = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    errorCode: "session.not_found",
    errorMessage: "Session not found.",
    outcome: "failed"
  });

  assert.equal(retrying.commands[0]?.type, "session/reconcile");
  assert.equal(retrying.state.recordsBySessionId["session-1"]?.errorCode, null);
  assert.equal(
    retrying.state.recordsBySessionId["session-1"]?.errorMessage,
    null
  );
});

test("live Turn provenance forces state hydration after a failed reconcile", () => {
  let state = reduce(createInitialSessionReconcileState(), {
    type: "session/activityObserved",
    agentSessionId: "session-1",
    eventType: "turn_update",
    hasCachedSession: false,
    hasInlineMessages: false,
    inlineApplied: false,
    workspaceId: "workspace-1"
  }).state;
  assert.equal(state.recordsBySessionId["session-1"]?.inFlightLive, true);

  state = reduce(state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "failed"
  }).state;
  assert.equal(state.recordsBySessionId["session-1"]?.pendingLive, true);

  const retried = reduce(state, {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: false,
    workspaceId: "workspace-1"
  });
  const command = retried.commands[0];
  assert.equal(command?.type, "session/reconcile");
  if (command?.type !== "session/reconcile") return;
  assert.equal(command.live, true);
  assert.equal(command.scope, "state_and_messages");
});

function reduce(
  state: ReturnType<typeof createInitialSessionReconcileState>,
  intent: Parameters<typeof sessionReconcileReducer>[1]
) {
  return sessionReconcileReducer(state, intent);
}
