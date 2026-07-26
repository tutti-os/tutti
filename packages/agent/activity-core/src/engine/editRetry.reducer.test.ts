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

test("successful edit retry refreshes availability and requests authoritative reconcile", () => {
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
      availability: {
        availableActions: [],
        eligible: false,
        historyRevision: 9,
        recoveryState: "completed",
        supported: true
      },
      result: {
        historyRevision: 9,
        operationId: "operation-1",
        replacementTurnId: "turn-2",
        retractedTurnId: "turn-1",
        state: "completed"
      }
    }
  });
  assert.equal(
    settled.state.editRetry.availabilityBySessionId["session-1"]
      ?.historyRevision,
    9
  );
  assert.deepEqual(
    settled.followUpIntents?.map((intent) => intent.type),
    ["session/reconcileRequested"]
  );
});
