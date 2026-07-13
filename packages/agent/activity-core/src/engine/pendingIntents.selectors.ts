import type { AgentSessionEngineState } from "./types.ts";
import type {
  PendingActivationIntentRecord,
  PendingSubmitIntentRecord
} from "./pendingIntents.types.ts";

export function selectPendingActivations(
  state: AgentSessionEngineState
): readonly PendingActivationIntentRecord[] {
  return Object.values(state.pendingIntents.activationsByRequestId).sort(
    (left, right) =>
      left.requestedAtUnixMs - right.requestedAtUnixMs ||
      left.requestId.localeCompare(right.requestId)
  );
}

export function selectPendingActivationByRequestId(
  state: AgentSessionEngineState,
  requestId: string | null | undefined
): PendingActivationIntentRecord | null {
  const id = requestId?.trim() ?? "";
  return state.pendingIntents.activationsByRequestId[id] ?? null;
}

const EMPTY_PENDING_SUBMITS: readonly PendingSubmitIntentRecord[] = [];

export interface SessionActivationPresentation {
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  status: "inactive" | "activating" | "active" | "failed";
}

export function selectPendingSubmitsForSession(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): readonly PendingSubmitIntentRecord[] {
  const id = agentSessionId?.trim() ?? "";
  const matches = Object.values(
    state.pendingIntents.submitsByClientSubmitId
  ).filter((pending) => pending.agentSessionId === id);
  return matches.length > 0 ? matches : EMPTY_PENDING_SUBMITS;
}

export function pendingSubmitRecordListsEqual(
  left: readonly PendingSubmitIntentRecord[],
  right: readonly PendingSubmitIntentRecord[]
): boolean {
  return (
    left.length === right.length &&
    left.every((record, index) => record === right[index])
  );
}

export function selectSessionIsSubmitting(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  const id = agentSessionId?.trim() ?? "";
  if (!id) {
    return false;
  }
  const visibleQueuedSubmitIds = new Set(
    (state.promptQueue.recordsBySessionId[id]?.prompts ?? [])
      .filter((prompt) => prompt.visibleInQueue !== false)
      .map((prompt) => prompt.clientSubmitId)
      .filter((value): value is string => Boolean(value))
  );
  return selectPendingSubmitsForSession(state, id).some(
    (pending) =>
      (pending.status === "requested" || pending.status === "uncertain") &&
      !visibleQueuedSubmitIds.has(pending.clientSubmitId)
  );
}

export function selectSessionHasUnconfirmedSubmit(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  return selectPendingSubmitsForSession(state, agentSessionId).some(
    (pending) => pending.status === "accepted"
  );
}

export function selectLatestPendingSubmitForSession(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): PendingSubmitIntentRecord | null {
  let latest: PendingSubmitIntentRecord | null = null;
  for (const pending of selectPendingSubmitsForSession(state, agentSessionId)) {
    if (!latest || pending.requestedAtUnixMs >= latest.requestedAtUnixMs) {
      latest = pending;
    }
  }
  return latest;
}

export function selectLatestActivationForSession(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): PendingActivationIntentRecord | null {
  const id = agentSessionId?.trim() ?? "";
  let latest: PendingActivationIntentRecord | null = null;
  for (const activation of Object.values(
    state.pendingIntents.activationsByRequestId
  )) {
    if (
      activation.agentSessionId === id &&
      (!latest || activation.requestedAtUnixMs >= latest.requestedAtUnixMs)
    ) {
      latest = activation;
    }
  }
  return latest;
}

export function selectSessionActivationPresentations(
  state: AgentSessionEngineState
): Readonly<Record<string, SessionActivationPresentation>> {
  const latestBySessionId = new Map<string, PendingActivationIntentRecord>();
  for (const activation of Object.values(
    state.pendingIntents.activationsByRequestId
  )) {
    const current = latestBySessionId.get(activation.agentSessionId);
    if (!current || activation.requestedAtUnixMs >= current.requestedAtUnixMs) {
      latestBySessionId.set(activation.agentSessionId, activation);
    }
  }
  const result: Record<string, SessionActivationPresentation> = {};
  for (const [agentSessionId, activation] of latestBySessionId) {
    result[agentSessionId] = {
      errorCode: activation.errorCode,
      errorMessage: activation.errorMessage,
      requestId: activation.requestId,
      status:
        activation.settingsUpdateStatus === "failed"
          ? "failed"
          : activation.status === "confirmed"
            ? "active"
            : activation.status === "failed"
              ? "failed"
              : "activating"
    };
  }
  for (const agentSessionId of Object.keys(
    state.pendingIntents.inactiveSessionIds
  )) {
    result[agentSessionId] = {
      errorCode: null,
      errorMessage: null,
      requestId: null,
      status: "inactive"
    };
  }
  return result;
}

export function sessionActivationPresentationMapsEqual(
  left: Readonly<Record<string, SessionActivationPresentation>>,
  right: Readonly<Record<string, SessionActivationPresentation>>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => {
      const a = left[key];
      const b = right[key];
      return (
        b !== undefined &&
        a?.errorCode === b.errorCode &&
        a.errorMessage === b.errorMessage &&
        a.requestId === b.requestId &&
        a.status === b.status
      );
    })
  );
}
