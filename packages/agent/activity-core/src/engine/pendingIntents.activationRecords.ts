import type {
  PendingActivationIntentRecord,
  PendingIntentsState
} from "./pendingIntents.types.ts";

export function replaceActivation(
  state: PendingIntentsState,
  record: PendingActivationIntentRecord
): PendingIntentsState {
  return {
    ...state,
    activationsByRequestId: {
      ...state.activationsByRequestId,
      [record.requestId]: record
    }
  };
}

export function deleteActivation(
  state: PendingIntentsState,
  requestId: string
): PendingIntentsState {
  const activations = { ...state.activationsByRequestId };
  delete activations[requestId];
  return { ...state, activationsByRequestId: activations };
}
