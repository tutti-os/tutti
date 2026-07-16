import type { AgentActivityCollaborationRun } from "../collaboration.types.ts";
import { selectCollaborationOperation } from "./collaborationOperations.selectors.ts";
import type { CollaborationOperationRequestedIntent } from "./collaborationOperations.types.ts";
import type { AgentSessionEngine, AgentSessionEngineState } from "./types.ts";

/**
 * Dispatches one collaboration mutation and resolves from the corresponding
 * engine operation record. Callers may use the Promise for UI consequences,
 * but pending and terminal workflow state remains owned by the engine.
 */
export function dispatchCollaborationOperation(
  engine: AgentSessionEngine,
  intent: CollaborationOperationRequestedIntent
): Promise<AgentActivityCollaborationRun> {
  const requestId = intent.requestId.trim();
  const workspaceId = intent.input.workspaceId.trim();
  if (!requestId || !workspaceId) {
    return Promise.reject(new Error("collaboration_operation_invalid"));
  }
  if (workspaceId !== engine.identity.workspaceId) {
    return Promise.reject(
      new Error("collaboration_operation_workspace_mismatch")
    );
  }
  const existing = selectCollaborationOperation(
    engine.getSnapshot(),
    requestId
  );
  if (existing?.status === "inFlight") {
    return Promise.reject(new Error("collaboration_operation_in_flight"));
  }
  if (existing) {
    engine.dispatch({
      requestId,
      type: "collaboration/operationDismissed"
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const settle = (state: AgentSessionEngineState): void => {
      if (settled) return;
      const operation = selectCollaborationOperation(state, requestId);
      if (!operation || operation.status === "inFlight") return;
      settled = true;
      unsubscribe();
      engine.dispatch({
        requestId,
        type: "collaboration/operationDismissed"
      });
      if (operation.status === "succeeded" && operation.result) {
        resolve(operation.result);
        return;
      }
      reject(
        new Error(
          operation.errorMessage ??
            operation.errorCode ??
            "collaboration_operation_failed"
        )
      );
    };
    unsubscribe = engine.subscribe(settle);
    engine.dispatch(intent);
    const state = engine.getSnapshot();
    if (!selectCollaborationOperation(state, requestId)) {
      settled = true;
      unsubscribe();
      reject(new Error("collaboration_operation_rejected"));
      return;
    }
    settle(state);
  });
}
