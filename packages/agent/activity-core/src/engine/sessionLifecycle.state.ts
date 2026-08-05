import { createInitialSettingsUpdate } from "./sessionSettings.reducer.ts";
import type {
  SessionCancelState,
  SessionLifecycleState,
  SessionOperationState
} from "./sessionLifecycle.types.ts";

export function initialOperation(): SessionOperationState {
  return {
    runtimeAvailability: { state: "available" },
    cancel: initialCancel(),
    operationError: null,
    settingsUpdate: createInitialSettingsUpdate()
  };
}

export function initialCancel(): SessionCancelState {
  return {
    commandId: null,
    errorCode: null,
    errorMessage: null,
    expiryId: null,
    requestedSessionVersion: null,
    requestedWorkspaceId: null,
    targetClientSubmitId: null,
    status: "idle",
    turnId: null
  };
}

export function requestedCancel(
  commandId: string,
  turnId: string | null,
  requestedWorkspaceId: string,
  targetClientSubmitId: string | null = null
): SessionCancelState {
  return {
    ...initialCancel(),
    commandId,
    requestedWorkspaceId,
    status: "requested",
    targetClientSubmitId,
    turnId
  };
}

export function cancelPending(cancel: SessionCancelState): boolean {
  return cancel.status === "requested" || cancel.status === "awaitingTurn";
}

export function setCancel(
  state: SessionLifecycleState,
  id: string,
  cancel: SessionCancelState
): SessionLifecycleState {
  const operation = state.operationBySessionId[id];
  return operation ? setOperation(state, id, { ...operation, cancel }) : state;
}

export function setOperation(
  state: SessionLifecycleState,
  id: string,
  operation: SessionOperationState
): SessionLifecycleState {
  return {
    ...state,
    operationBySessionId: { ...state.operationBySessionId, [id]: operation }
  };
}
