import type { PendingIntentsState } from "./pendingIntents.types.ts";
import { deleteSubmit, submitExpiryId } from "./pendingSubmit.reducer.ts";
import type { EngineReducerResult } from "./types.ts";

export function removeSessionPendingIntents(
  state: PendingIntentsState,
  agentSessionId: string
): EngineReducerResult<PendingIntentsState> {
  const normalizedSessionId = agentSessionId.trim();
  const submitIds = Object.values(state.submitsByClientSubmitId)
    .filter((record) => record.agentSessionId === normalizedSessionId)
    .map((record) => record.clientSubmitId);
  const activationIds = Object.values(state.activationsByRequestId)
    .filter((record) => record.agentSessionId === normalizedSessionId)
    .map((record) => record.requestId);
  const wasInactive = state.inactiveSessionIds[normalizedSessionId] === true;
  if (submitIds.length === 0 && activationIds.length === 0 && !wasInactive) {
    return { commands: [], state };
  }
  return {
    commands: [
      ...submitIds.map((id) => ({
        expiryId: submitExpiryId(id),
        type: "engine/cancelExpiry" as const
      })),
      ...activationIds.map((id) => ({
        expiryId: `activation:${id}`,
        type: "engine/cancelExpiry" as const
      }))
    ],
    state: removeInactiveSession(
      activationIds.reduce(
        deleteActivation,
        submitIds.reduce(deleteSubmit, state)
      ),
      normalizedSessionId
    )
  };
}

function deleteActivation(
  state: PendingIntentsState,
  requestId: string
): PendingIntentsState {
  const activations = { ...state.activationsByRequestId };
  delete activations[requestId];
  return { ...state, activationsByRequestId: activations };
}

function removeInactiveSession(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  if (!state.inactiveSessionIds[agentSessionId]) return state;
  const inactiveSessionIds = { ...state.inactiveSessionIds };
  delete inactiveSessionIds[agentSessionId];
  return { ...state, inactiveSessionIds };
}
