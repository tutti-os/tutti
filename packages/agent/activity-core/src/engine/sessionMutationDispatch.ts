import { selectSessionMutation } from "./sessionMutations.selectors.ts";
import type {
  SessionMutationRecord,
  SessionMutationsIntent
} from "./sessionMutations.types.ts";
import type { AgentSessionEngine } from "./types.ts";

export function dispatchSessionMutation(
  engine: AgentSessionEngine,
  intent: SessionMutationsIntent
): Promise<SessionMutationRecord> {
  const mutationId = intent.mutationId.trim();
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
