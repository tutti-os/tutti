import type { SessionReconcileRecord } from "./sessionReconcile.types.ts";
import type { AgentSessionEngineState } from "./types.ts";

export function selectEngineSessionReconcile(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionReconcileRecord | null {
  const id = agentSessionId?.trim() ?? "";
  return id ? (state.sessionReconcile.recordsBySessionId[id] ?? null) : null;
}

export interface AuthoritativeHistoryRequirement {
  appliedHistoryRevision: number | null;
  minimumHistoryRevision: number;
  needsAuthoritativeMessages: boolean;
}

export function selectEngineAuthoritativeHistoryRequirement(
  state: AgentSessionEngineState,
  input: {
    agentSessionId: string;
    forceAuthoritativeMessages?: boolean;
    observedHistoryRevision: number;
    requestedHistoryRevision?: number;
  }
): AuthoritativeHistoryRequirement {
  const id = input.agentSessionId.trim();
  const record = id ? state.sessionReconcile.recordsBySessionId[id] : undefined;
  const appliedHistoryRevision = record?.appliedHistoryRevision ?? null;
  const requestedHistoryRevisions = [
    record?.requiredHistoryRevision,
    input.requestedHistoryRevision
  ].filter(
    (revision): revision is number =>
      revision !== undefined && revision !== null
  );
  const requiredHistoryRevision =
    requestedHistoryRevisions.length > 0
      ? Math.max(...requestedHistoryRevisions)
      : null;
  const hasCachedMessages =
    (id ? (state.sessionMessages.messagesBySessionId[id]?.length ?? 0) : 0) !==
    0;
  return {
    appliedHistoryRevision,
    minimumHistoryRevision: Math.max(
      requiredHistoryRevision ?? 0,
      input.observedHistoryRevision
    ),
    needsAuthoritativeMessages:
      input.forceAuthoritativeMessages === true ||
      record?.authoritativeMessagesRequired === true ||
      (requiredHistoryRevision !== null &&
        requiredHistoryRevision > (appliedHistoryRevision ?? -1)) ||
      (appliedHistoryRevision === null && hasCachedMessages) ||
      (appliedHistoryRevision !== null &&
        input.observedHistoryRevision !== appliedHistoryRevision)
  };
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
