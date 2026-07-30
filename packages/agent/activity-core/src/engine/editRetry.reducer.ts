import type {
  EngineCommand,
  EngineCommandResultIntent,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type {
  AgentActivityEditRetryAvailability,
  AgentActivityEditRetryResult,
  EditRetryOperationRecord,
  EditRetryState,
  EditRetryTailPresentation
} from "./editRetry.types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const IDLE_OPERATION: EditRetryOperationRecord = {
  clientOperationId: null,
  commandId: null,
  errorCode: null,
  errorMessage: null,
  requestKey: null,
  result: null,
  status: "idle",
  workspaceId: null
};

export function createInitialEditRetryState(): EditRetryState {
  return {
    availabilityBySessionId: {},
    nextCommandSequence: 1,
    operationBySessionId: {},
    tailBySessionId: {}
  };
}

export function editRetryReducer(
  state: EditRetryState,
  intent: EngineIntent
): EngineReducerResult<EditRetryState> {
  switch (intent.type) {
    case "editRetry/availabilityReceived":
      return receiveAvailability(state, intent);
    case "editRetry/requested":
      return requestEditRetry(state, intent);
    case "editRetry/recoveryRequested":
      return requestRecovery(state, intent);
    case "engine/commandResult":
      return intent.commandType === "turn/editRetry" ||
        intent.commandType === "turn/recoverEditRetry"
        ? settleCommand(state, intent)
        : unchanged(state);
    case "session/removed":
      return removeSession(state, intent.agentSessionId);
    default:
      return unchanged(state);
  }
}

function receiveAvailability(
  state: EditRetryState,
  intent: Extract<EngineIntent, { type: "editRetry/availabilityReceived" }>
): EngineReducerResult<EditRetryState> {
  const agentSessionId = intent.agentSessionId.trim();
  if (!agentSessionId) {
    return unchanged(state);
  }
  const current = state.availabilityBySessionId[agentSessionId];
  const operation = state.operationBySessionId[agentSessionId];
  const confirmsOperation =
    operation?.status === "reconciling" &&
    operation.result &&
    availabilityConfirmsResult(intent.availability, operation.result);
  if (availabilityEqual(current, intent.availability)) {
    return confirmsOperation
      ? {
          commands: NO_COMMANDS,
          state: replaceOperation(state, agentSessionId, {
            ...operation,
            result: null,
            status: "succeeded"
          })
        }
      : unchanged(state);
  }
  const nextState = {
    ...state,
    availabilityBySessionId: {
      ...state.availabilityBySessionId,
      [agentSessionId]: cloneAvailability(intent.availability)
    }
  };
  return {
    commands: NO_COMMANDS,
    state: confirmsOperation
      ? replaceOperation(nextState, agentSessionId, {
          ...operation,
          result: null,
          status: "succeeded"
        })
      : nextState
  };
}

function requestEditRetry(
  state: EditRetryState,
  intent: Extract<EngineIntent, { type: "editRetry/requested" }>
): EngineReducerResult<EditRetryState> {
  const agentSessionId = intent.agentSessionId.trim();
  const workspaceId = intent.workspaceId.trim();
  const turnId = intent.turnId.trim();
  const availability = state.availabilityBySessionId[agentSessionId];
  const current = state.operationBySessionId[agentSessionId] ?? IDLE_OPERATION;
  if (
    !agentSessionId ||
    !workspaceId ||
    !turnId ||
    current.status === "pending" ||
    availability?.eligible !== true ||
    availability.turnId?.trim() !== turnId
  ) {
    return unchanged(state);
  }

  const requestKey = editRetryRequestKey({
    editedText: intent.editedText,
    historyRevision: availability.historyRevision,
    turnId
  });
  const clientOperationId =
    current.requestKey === requestKey && current.clientOperationId
      ? current.clientOperationId
      : editRetryClientOperationId(requestKey);
  const commandId = `turn:editRetry:${agentSessionId}:${state.nextCommandSequence}`;
  return {
    commands: [
      {
        agentSessionId,
        clientOperationId,
        commandId,
        editedText: intent.editedText,
        expectedHistoryRevision: availability.historyRevision,
        timeoutMs: 60_000,
        turnId,
        type: "turn/editRetry",
        workspaceId
      }
    ],
    state: {
      ...state,
      nextCommandSequence: state.nextCommandSequence + 1,
      operationBySessionId: {
        ...state.operationBySessionId,
        [agentSessionId]: {
          clientOperationId,
          commandId,
          errorCode: null,
          errorMessage: null,
          requestKey,
          result: null,
          status: "pending",
          workspaceId
        }
      },
      tailBySessionId: {
        ...state.tailBySessionId,
        [agentSessionId]: {
          clientOperationId,
          editedText: intent.editedText,
          operationId: null,
          replacementTurnId: null,
          retractedTurnId: turnId,
          workspaceId
        }
      }
    }
  };
}

function requestRecovery(
  state: EditRetryState,
  intent: Extract<EngineIntent, { type: "editRetry/recoveryRequested" }>
): EngineReducerResult<EditRetryState> {
  const agentSessionId = intent.agentSessionId.trim();
  const workspaceId = intent.workspaceId.trim();
  const availability = state.availabilityBySessionId[agentSessionId];
  const operationId = availability?.operationId?.trim() ?? "";
  const current = state.operationBySessionId[agentSessionId] ?? IDLE_OPERATION;
  if (
    !agentSessionId ||
    !workspaceId ||
    !operationId ||
    current.status === "pending" ||
    !availability?.availableActions.includes(intent.action)
  ) {
    return unchanged(state);
  }
  const commandId = `turn:recoverEditRetry:${agentSessionId}:${state.nextCommandSequence}`;
  return {
    commands: [
      {
        action: intent.action,
        agentSessionId,
        commandId,
        operationId,
        timeoutMs: 60_000,
        type: "turn/recoverEditRetry",
        workspaceId
      }
    ],
    state: {
      ...state,
      nextCommandSequence: state.nextCommandSequence + 1,
      operationBySessionId: {
        ...state.operationBySessionId,
        [agentSessionId]: {
          ...current,
          commandId,
          errorCode: null,
          errorMessage: null,
          result: null,
          status: "pending",
          workspaceId
        }
      }
    }
  };
}

function settleCommand(
  state: EditRetryState,
  intent: EngineCommandResultIntent
): EngineReducerResult<EditRetryState> {
  const entry = Object.entries(state.operationBySessionId).find(
    ([, operation]) => operation.commandId === intent.commandId
  );
  if (!entry) {
    return unchanged(state);
  }
  const [agentSessionId, operation] = entry;
  const workspaceId = operation.workspaceId?.trim() ?? "";
  const result =
    intent.outcome === "succeeded" ? parseEditRetryResult(intent.value) : null;
  if (!result) {
    return {
      commands: NO_COMMANDS,
      ...(workspaceId
        ? {
            followUpIntents: [
              {
                agentSessionId,
                needsMessages: true,
                needsState: true,
                type: "session/reconcileRequested" as const,
                workspaceId
              }
            ]
          }
        : {}),
      state: replaceOperation(state, agentSessionId, {
        ...operation,
        commandId: null,
        errorCode: intent.errorCode?.trim() || null,
        errorMessage:
          intent.errorMessage?.trim() ||
          (intent.outcome === "succeeded"
            ? "agent_edit_retry_invalid_result"
            : "agent_edit_retry_command_failed"),
        result: null,
        status: "failed"
      })
    };
  }
  const tail = state.tailBySessionId[agentSessionId];
  const nextState = replaceOperation(state, agentSessionId, {
    ...operation,
    commandId: null,
    errorCode: null,
    errorMessage: null,
    result,
    status: "reconciling"
  });
  return {
    commands: NO_COMMANDS,
    followUpIntents: [
      {
        agentSessionId,
        authoritativeMessages: true,
        needsMessages: false,
        needsState: false,
        requiredHistoryRevision: result.historyRevision,
        type: "session/reconcileRequested",
        workspaceId
      }
    ],
    state:
      tail && tail.retractedTurnId === result.retractedTurnId
        ? replaceTail(nextState, agentSessionId, {
            ...tail,
            operationId: result.operationId,
            replacementTurnId: result.replacementTurnId?.trim() || null
          })
        : nextState
  };
}

function parseEditRetryResult(
  value: unknown
): AgentActivityEditRetryResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const result = value as Partial<AgentActivityEditRetryResult>;
  if (
    typeof result.operationId !== "string" ||
    typeof result.state !== "string" ||
    typeof result.retractedTurnId !== "string" ||
    typeof result.historyRevision !== "number"
  ) {
    return null;
  }
  return result as AgentActivityEditRetryResult;
}

function availabilityConfirmsResult(
  availability: AgentActivityEditRetryAvailability,
  result: AgentActivityEditRetryResult
): boolean {
  if (availability.historyRevision < result.historyRevision) {
    return false;
  }
  if (result.state === "completed") {
    return availability.recoveryState === "prepared";
  }
  return (
    availability.operationId === result.operationId &&
    availability.recoveryState === result.state
  );
}

function cloneAvailability(
  availability: AgentActivityEditRetryAvailability
): AgentActivityEditRetryAvailability {
  return {
    ...availability,
    availableActions: [...availability.availableActions]
  };
}

function availabilityEqual(
  left: AgentActivityEditRetryAvailability | undefined,
  right: AgentActivityEditRetryAvailability
): boolean {
  return (
    left?.supported === right.supported &&
    left.eligible === right.eligible &&
    left.turnId === right.turnId &&
    left.historyRevision === right.historyRevision &&
    left.recoveryState === right.recoveryState &&
    left.operationId === right.operationId &&
    left.reasonCode === right.reasonCode &&
    left.availableActions.length === right.availableActions.length &&
    left.availableActions.every(
      (action, index) => action === right.availableActions[index]
    )
  );
}

function replaceOperation(
  state: EditRetryState,
  agentSessionId: string,
  operation: EditRetryOperationRecord
): EditRetryState {
  return {
    ...state,
    operationBySessionId: {
      ...state.operationBySessionId,
      [agentSessionId]: operation
    }
  };
}

function replaceTail(
  state: EditRetryState,
  agentSessionId: string,
  tail: EditRetryTailPresentation
): EditRetryState {
  return {
    ...state,
    tailBySessionId: {
      ...state.tailBySessionId,
      [agentSessionId]: tail
    }
  };
}

function removeSession(
  state: EditRetryState,
  rawAgentSessionId: string
): EngineReducerResult<EditRetryState> {
  const agentSessionId = rawAgentSessionId.trim();
  if (
    !state.availabilityBySessionId[agentSessionId] &&
    !state.operationBySessionId[agentSessionId] &&
    !state.tailBySessionId[agentSessionId]
  ) {
    return unchanged(state);
  }
  const availabilityBySessionId = { ...state.availabilityBySessionId };
  const operationBySessionId = { ...state.operationBySessionId };
  const tailBySessionId = { ...state.tailBySessionId };
  delete availabilityBySessionId[agentSessionId];
  delete operationBySessionId[agentSessionId];
  delete tailBySessionId[agentSessionId];
  return {
    commands: NO_COMMANDS,
    state: {
      ...state,
      availabilityBySessionId,
      operationBySessionId,
      tailBySessionId
    }
  };
}

function editRetryRequestKey(input: {
  editedText: string;
  historyRevision: number;
  turnId: string;
}): string {
  return JSON.stringify([
    input.turnId.trim(),
    input.historyRevision,
    input.editedText
  ]);
}

function editRetryClientOperationId(requestKey: string): string {
  const left = hash32(requestKey, 0x811c9dc5);
  const right = hash32(requestKey, 0x9e3779b9);
  return `edit-retry-${hex32(left)}-${hex32(right)}`;
}

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 13;
  }
  return hash >>> 0;
}

function hex32(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function unchanged(state: EditRetryState): EngineReducerResult<EditRetryState> {
  return { commands: NO_COMMANDS, state };
}
