import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";

const AVAILABLE = {
  availableActions: [],
  eligible: true,
  historyRevision: 7,
  recoveryState: "prepared" as const,
  supported: true,
  turnId: "turn-1"
};

test("edit retry owns stable identity and command settlement in the engine", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    availability: AVAILABLE,
    type: "editRetry/availabilityReceived",
    workspaceId: "workspace-1"
  }).state;
  const first = rootEngineReducer(state, {
    agentSessionId: "session-1",
    editedText: "edited",
    turnId: "turn-1",
    type: "editRetry/requested",
    workspaceId: "workspace-1"
  });
  assert.equal(first.commands.length, 1);
  const command = first.commands[0];
  assert.equal(command?.type, "turn/editRetry");
  if (command?.type !== "turn/editRetry") return;

  const failed = rootEngineReducer(first.state, {
    commandId: command.commandId,
    commandType: command.type,
    errorMessage: "offline",
    outcome: "failed",
    type: "engine/commandResult"
  });
  assert.equal(failed.followUpIntents?.[0]?.type, "session/reconcileRequested");
  const retried = rootEngineReducer(failed.state, {
    agentSessionId: "session-1",
    editedText: "edited",
    turnId: "turn-1",
    type: "editRetry/requested",
    workspaceId: "workspace-1"
  });
  const retryCommand = retried.commands[0];
  assert.equal(retryCommand?.type, "turn/editRetry");
  if (retryCommand?.type !== "turn/editRetry") return;
  assert.equal(retryCommand.clientOperationId, command.clientOperationId);

  const changed = rootEngineReducer(failed.state, {
    agentSessionId: "session-1",
    editedText: "different",
    turnId: "turn-1",
    type: "editRetry/requested",
    workspaceId: "workspace-1"
  });
  const changedCommand = changed.commands[0];
  assert.equal(changedCommand?.type, "turn/editRetry");
  if (changedCommand?.type !== "turn/editRetry") return;
  assert.notEqual(changedCommand.clientOperationId, command.clientOperationId);
});

test("successful edit retry waits for authoritative availability and requests reconcile", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    availability: AVAILABLE,
    type: "editRetry/availabilityReceived",
    workspaceId: "workspace-1"
  }).state;
  const requested = rootEngineReducer(state, {
    agentSessionId: "session-1",
    editedText: "edited",
    turnId: "turn-1",
    type: "editRetry/requested",
    workspaceId: "workspace-1"
  });
  const command = requested.commands[0];
  assert.equal(command?.type, "turn/editRetry");
  if (command?.type !== "turn/editRetry") return;

  const settled = rootEngineReducer(requested.state, {
    commandId: command.commandId,
    commandType: command.type,
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      historyRevision: 9,
      operationId: "operation-1",
      replacementTurnId: "turn-2",
      retractedTurnId: "turn-1",
      state: "completed"
    }
  });
  assert.equal(
    settled.state.editRetry.availabilityBySessionId["session-1"]
      ?.historyRevision,
    7
  );
  assert.equal(
    settled.state.editRetry.operationBySessionId["session-1"]?.status,
    "reconciling"
  );
  assert.deepEqual(settled.followUpIntents, [
    {
      agentSessionId: "session-1",
      authoritativeMessages: true,
      needsMessages: false,
      needsState: false,
      requiredHistoryRevision: 9,
      type: "session/reconcileRequested",
      workspaceId: "workspace-1"
    }
  ]);

  const reconciled = rootEngineReducer(settled.state, {
    agentSessionId: "session-1",
    availability: {
      availableActions: [],
      eligible: false,
      historyRevision: 9,
      recoveryState: "prepared",
      supported: true
    },
    type: "editRetry/availabilityReceived",
    workspaceId: "workspace-1"
  });
  assert.equal(
    reconciled.state.editRetry.operationBySessionId["session-1"]?.status,
    "succeeded"
  );
});

test("authoritative unchanged availability settles a read-only recovery", () => {
  const recoveryAvailability = {
    ...AVAILABLE,
    availableActions: ["reconcile"] as const,
    eligible: false,
    operationId: "operation-1",
    operationVersion: 3,
    recoveryState: "resend_pending" as const,
    turnId: undefined
  };
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    availability: recoveryAvailability,
    type: "editRetry/availabilityReceived",
    workspaceId: "workspace-1"
  }).state;
  const requested = rootEngineReducer(state, {
    action: "reconcile",
    agentSessionId: "session-1",
    type: "editRetry/recoveryRequested",
    workspaceId: "workspace-1"
  });
  const command = requested.commands[0];
  assert.equal(command?.type, "turn/recoverEditRetry");
  if (command?.type !== "turn/recoverEditRetry") return;
  assert.equal(command.expectedOperationVersion, 3);
  assert.equal(command.expectedHistoryRevision, 7);
  assert.match(command.clientActionId, /^edit-retry-/);

  const failed = rootEngineReducer(requested.state, {
    commandId: command.commandId,
    commandType: command.type,
    errorCode: "unavailable",
    errorReason: "transport_unavailable",
    outcome: "failed",
    type: "engine/commandResult"
  });
  const retried = rootEngineReducer(failed.state, {
    action: "reconcile",
    agentSessionId: "session-1",
    type: "editRetry/recoveryRequested",
    workspaceId: "workspace-1"
  });
  const retryCommand = retried.commands[0];
  assert.equal(retryCommand?.type, "turn/recoverEditRetry");
  if (retryCommand?.type !== "turn/recoverEditRetry") return;
  assert.equal(retryCommand.clientActionId, command.clientActionId);

  const accepted = rootEngineReducer(requested.state, {
    commandId: command.commandId,
    commandType: command.type,
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      historyRevision: 7,
      operationId: "operation-1",
      retractedTurnId: "turn-1",
      state: "resend_pending"
    }
  });
  const reconciled = rootEngineReducer(accepted.state, {
    agentSessionId: "session-1",
    availability: recoveryAvailability,
    type: "editRetry/availabilityReceived",
    workspaceId: "workspace-1"
  });
  assert.equal(
    reconciled.state.editRetry.operationBySessionId["session-1"]?.status,
    "succeeded"
  );
});
