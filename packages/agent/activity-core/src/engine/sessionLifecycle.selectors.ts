import type {
  AgentActivitySession,
  AgentActivitySubmitAvailability
} from "../types.ts";
import type { AgentSessionEngineState } from "./types.ts";
import type {
  SessionCancelState,
  SessionLifecycleRecord
} from "./sessionLifecycle.types.ts";

export function selectEngineSession(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): AgentActivitySession | null {
  const id = agentSessionId?.trim() ?? "";
  const record = state.sessionLifecycle.recordsBySessionId[id];
  return record?.session ?? null;
}

export function selectEngineSubmitAvailability(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): AgentActivitySubmitAvailability | null {
  const id = agentSessionId?.trim() ?? "";
  const record = state.sessionLifecycle.recordsBySessionId[id];
  if (!record) {
    return null;
  }
  if (record.pendingInteractions.length > 0) {
    return { state: "blocked", reason: "waiting" };
  }
  if (record.activeTurn && record.activeTurn.phase !== "settled") {
    return { state: "blocked", reason: "active_turn" };
  }
  return { state: "available" };
}

export function selectEngineCancelPending(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  const id = agentSessionId?.trim() ?? "";
  const status = state.sessionLifecycle.recordsBySessionId[id]?.cancel.status;
  return status === "requested" || status === "awaitingTurn";
}

export function selectEngineCancelState(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionCancelState | null {
  const id = agentSessionId?.trim() ?? "";
  return state.sessionLifecycle.recordsBySessionId[id]?.cancel ?? null;
}

export function selectEngineSessionLifecycleRecord(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionLifecycleRecord | null {
  const id = agentSessionId?.trim() ?? "";
  return state.sessionLifecycle.recordsBySessionId[id] ?? null;
}

export function selectEngineHasPendingInteractions(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  return (
    (selectEngineSessionLifecycleRecord(state, agentSessionId)
      ?.pendingInteractions.length ?? 0) > 0
  );
}

export function selectEngineSessionError(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): string | null {
  const id = agentSessionId?.trim() ?? "";
  const record = state.sessionLifecycle.recordsBySessionId[id];
  return record?.operationError ?? record?.activeTurn?.error?.message ?? null;
}
