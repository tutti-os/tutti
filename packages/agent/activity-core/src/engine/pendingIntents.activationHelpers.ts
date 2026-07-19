import type {
  PendingActivationIntentRecord,
  PendingIntentsState
} from "./pendingIntents.types.ts";
import type { EngineCommand, EngineReducerResult } from "./types.ts";
import type { AgentActivitySession } from "../types.ts";

export const NO_PENDING_INTENT_COMMANDS: readonly EngineCommand[] = [];

export function isActivationCommandResult(value: unknown): value is {
  activation: { status: string };
  error?: { code?: string; message?: string } | null;
  session?: AgentActivitySession;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as {
    activation?: { status?: unknown };
    error?: { code?: string; message?: string } | null;
    session?: AgentActivitySession;
  };
  return Boolean(
    result.activation && typeof result.activation.status === "string"
  );
}

export function activationExpiryId(requestId: string): string {
  return `activation:${requestId}`;
}

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

export function unchangedPendingIntents(
  state: PendingIntentsState
): EngineReducerResult<PendingIntentsState> {
  return { commands: NO_PENDING_INTENT_COMMANDS, state };
}
