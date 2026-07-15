import type { SessionReconcileRecord } from "./sessionReconcile.types.ts";
import type { AgentSessionEngineState } from "./types.ts";

export function selectEngineSessionReconcile(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionReconcileRecord | null {
  const id = agentSessionId?.trim() ?? "";
  return id ? (state.sessionReconcile.recordsBySessionId[id] ?? null) : null;
}

export function selectEngineSessionDetailHydrated(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  const id = agentSessionId?.trim() ?? "";
  if (!id) return false;
  return (
    Object.prototype.hasOwnProperty.call(
      state.sessionMessages.messagesBySessionId,
      id
    ) ||
    state.sessionReconcile.recordsBySessionId[id]?.messagesHydrated === true
  );
}

export function selectEngineSessionDetailLoading(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  const record = selectEngineSessionReconcile(state, agentSessionId);
  if (!record || selectEngineSessionDetailHydrated(state, agentSessionId)) {
    return false;
  }
  return (
    record.pendingMessages ||
    record.inFlightScope === "messages" ||
    record.inFlightScope === "state_and_messages"
  );
}
