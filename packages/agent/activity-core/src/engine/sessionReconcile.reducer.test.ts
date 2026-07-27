import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialSessionReconcileState,
  sessionReconcileReducer
} from "./sessionReconcile.reducer.ts";
import { selectEngineAuthoritativeHistoryRequirement } from "./sessionReconcile.selectors.ts";
import { createInitialAgentSessionEngineState } from "./rootReducer.ts";

test("an uncached initial read establishes a baseline without forcing full history", () => {
  const requirement = selectEngineAuthoritativeHistoryRequirement(
    createInitialAgentSessionEngineState(),
    {
      agentSessionId: "session-1",
      observedHistoryRevision: 0
    }
  );
  assert.deepEqual(requirement, {
    appliedHistoryRevision: null,
    minimumHistoryRevision: 0,
    needsAuthoritativeMessages: false
  });
});

test("cached messages without an applied revision require authoritative history", () => {
  const initial = createInitialAgentSessionEngineState();
  const requirement = selectEngineAuthoritativeHistoryRequirement(
    {
      ...initial,
      sessionMessages: {
        ...initial.sessionMessages,
        messagesBySessionId: {
          "session-1": [
            {
              agentSessionId: "session-1",
              kind: "text",
              messageId: "message-1",
              occurredAtUnixMs: 1,
              payload: {},
              role: "user",
              status: null,
              turnId: "turn-1",
              version: 1,
              workspaceId: "workspace-1"
            }
          ]
        }
      }
    },
    {
      agentSessionId: "session-1",
      observedHistoryRevision: 0
    }
  );
  assert.equal(requirement.needsAuthoritativeMessages, true);
});

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

test("terminal turn observation always verifies state and messages", () => {
  const result = reduce(createInitialSessionReconcileState(), {
    type: "session/activityObserved",
    agentSessionId: "session-1",
    eventType: "turn_update",
    hasCachedSession: true,
    hasInlineMessages: true,
    inlineApplied: true,
    terminalTurn: true,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(result.commands, [
    {
      agentSessionId: "session-1",
      commandId: "session:reconcile:session-1:1",
      scope: "state_and_messages",
      timeoutMs: 30_000,
      type: "session/reconcile",
      workspaceId: "workspace-1"
    }
  ]);
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
    appliedHistoryRevision: null,
    authoritativeMessagesRequired: false,
    errorCode: "session.not_found",
    errorMessage: "Session not found.",
    inFlightCommandId: null,
    inFlightLive: false,
    inFlightScope: null,
    messagesHydrated: false,
    pendingLive: false,
    pendingMessages: false,
    pendingState: false,
    requiredHistoryRevision: null,
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

test("required history revision stays pending until a composite authoritative snapshot applies", () => {
  let result = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: false,
    needsState: false,
    requiredHistoryRevision: 4,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(result.commands, [
    {
      agentSessionId: "session-1",
      authoritativeMessages: true,
      commandId: "session:reconcile:session-1:1",
      requiredHistoryRevision: 4,
      scope: "state_and_messages",
      timeoutMs: 30_000,
      type: "session/reconcile",
      workspaceId: "workspace-1"
    }
  ]);

  result = reduce(result.state, {
    agentSessionId: "session-1",
    childSessions: [],
    historyRevision: 4,
    messages: [],
    session: {
      agentSessionId: "session-1",
      workspaceId: "workspace-1"
    } as never,
    turns: [],
    type: "session/historyAuthoritativeSnapshotReceived",
    workspaceId: "workspace-1"
  });
  assert.equal(
    result.state.recordsBySessionId["session-1"]?.appliedHistoryRevision,
    4
  );
  assert.equal(
    result.state.recordsBySessionId["session-1"]?.authoritativeMessagesRequired,
    false
  );

  result = reduce(result.state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    outcome: "succeeded"
  });
  assert.equal(result.commands.length, 0);
});

test("authoritative demand arriving during an ordinary read retries exactly once after failure", () => {
  let result = reduce(createInitialSessionReconcileState(), {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: true,
    workspaceId: "workspace-1"
  });
  result = reduce(result.state, {
    type: "session/reconcileRequested",
    agentSessionId: "session-1",
    authoritativeMessages: true,
    needsMessages: false,
    needsState: false,
    requiredHistoryRevision: 2,
    workspaceId: "workspace-1"
  });
  assert.equal(result.commands.length, 0);

  result = reduce(result.state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:1",
    commandType: "session/reconcile",
    errorMessage: "revision changed",
    outcome: "failed"
  });
  assert.equal(result.commands[0]?.type, "session/reconcile");
  assert.equal(
    result.commands[0]?.type === "session/reconcile"
      ? result.commands[0].authoritativeMessages
      : false,
    true
  );

  result = reduce(result.state, {
    type: "engine/commandResult",
    commandId: "session:reconcile:session-1:2",
    commandType: "session/reconcile",
    errorMessage: "still unavailable",
    outcome: "failed"
  });
  assert.equal(result.commands.length, 0);
});

function reduce(
  state: ReturnType<typeof createInitialSessionReconcileState>,
  intent: Parameters<typeof sessionReconcileReducer>[1]
) {
  return sessionReconcileReducer(state, intent);
}
