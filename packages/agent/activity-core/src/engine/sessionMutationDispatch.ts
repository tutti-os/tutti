import {
  selectSessionForkThroughTurnMutation,
  selectSessionMutation
} from "./sessionMutations.selectors.ts";
import type {
  SessionMutationRecord,
  SessionMutationsIntent,
  SessionForkThroughTurnMutationRecord
} from "./sessionMutations.types.ts";
import type { AgentSessionEngine } from "./types.ts";

export interface DispatchSessionForkThroughTurnInput {
  sourceAgentSessionId: string;
  timeoutMs?: number;
  turnId: string;
  workspaceId: string;
}

export function dispatchSessionMutation(
  engine: AgentSessionEngine,
  intent: SessionMutationsIntent
): Promise<SessionMutationRecord> {
  const mutationId =
    intent.type === "session/forkThroughTurnRequested"
      ? intent.requestId.trim()
      : intent.mutationId.trim();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = (): void => {};
    const observe = (): void => {
      if (settled) return;
      const record = selectSessionMutation(engine.getSnapshot(), mutationId);
      if (!record || record.status === "inFlight") return;
      settled = true;
      unsubscribe();
      if (record.status === "succeeded") {
        resolve(record);
        return;
      }
      const error = new Error(
        record.errorMessage ?? `session mutation ${record.status}`
      ) as Error & { code?: string };
      if (record.errorCode) error.code = record.errorCode;
      reject(error);
    };
    unsubscribe = engine.subscribe(observe);
    engine.dispatch(intent);
    const accepted = selectSessionMutation(engine.getSnapshot(), mutationId);
    if (!accepted) {
      settled = true;
      unsubscribe();
      reject(new Error("session mutation was not accepted"));
      return;
    }
    observe();
  });
}

/**
 * Engine-owned through-Turn Fork facade. A React surface identifies only the
 * canonical boundary; the facade allocates a mutation identity or reuses the
 * Engine record's stable mutation key for that boundary. The durable provider
 * identity may differ after recovery and remains owned by that record. A
 * confirmed failure permits a genuinely new provider attempt.
 */
export function dispatchSessionForkThroughTurn(
  engine: AgentSessionEngine,
  input: DispatchSessionForkThroughTurnInput
): Promise<SessionForkThroughTurnMutationRecord> {
  const workspaceId = input.workspaceId.trim();
  const sourceAgentSessionId = input.sourceAgentSessionId.trim();
  const turnId = input.turnId.trim();
  const existing = selectSessionForkThroughTurnMutation(engine.getSnapshot(), {
    sourceAgentSessionId,
    turnId,
    workspaceId
  });
  const retryableExisting =
    existing?.status === "inFlight" ||
    existing?.status === "unknown" ||
    (existing?.status === "succeeded" &&
      existing.ackStatus !== "idle" &&
      existing.ackStatus !== "acknowledged")
      ? existing
      : null;
  const requestId =
    retryableExisting?.mutationId ?? createSessionForkIdentity();
  const targetAgentSessionId =
    retryableExisting?.targetAgentSessionId ?? createSessionForkIdentity();
  return dispatchSessionMutation(engine, {
    requestId,
    sourceAgentSessionId,
    targetAgentSessionId,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    turnId,
    type: "session/forkThroughTurnRequested",
    workspaceId
  }).then((record) => {
    if (record.kind !== "forkThroughTurn") {
      throw new Error("session fork resolved to a different mutation kind");
    }
    return record;
  });
}

function createSessionForkIdentity(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `00000000-0000-4000-8000-${fallbackHex.slice(0, 12)}`;
}
