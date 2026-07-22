import type { EngineReducerResult } from "./types.ts";
import type { PendingIntentsState } from "./pendingIntents.types.ts";

export function markSessionActive(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  return removeInactiveSession(state, agentSessionId);
}

export function markSessionInactive(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  const id = agentSessionId.trim();
  return state.inactiveSessionIds[id]
    ? state
    : {
        ...state,
        inactiveSessionIds: { ...state.inactiveSessionIds, [id]: true }
      };
}

export function removeInactiveSession(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  const id = agentSessionId.trim();
  if (!state.inactiveSessionIds[id]) {
    return state;
  }
  const inactiveSessionIds = { ...state.inactiveSessionIds };
  delete inactiveSessionIds[id];
  return { ...state, inactiveSessionIds };
}

export function unchanged(
  state: PendingIntentsState
): EngineReducerResult<PendingIntentsState> {
  return { commands: [], state };
}
