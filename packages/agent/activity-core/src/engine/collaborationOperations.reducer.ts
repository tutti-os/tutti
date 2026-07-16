import type { AgentActivityCollaborationRun } from "../collaboration.types.ts";
import type {
  CollaborationOperationKind,
  CollaborationOperationRecord,
  CollaborationOperationsCommand,
  CollaborationOperationsState
} from "./collaborationOperations.types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const COMMAND_TIMEOUT_MS = 30_000;

export function createInitialCollaborationOperationsState(): CollaborationOperationsState {
  return { byRequestId: {} };
}

export function collaborationOperationsReducer(
  state: CollaborationOperationsState,
  intent: EngineIntent
): EngineReducerResult<CollaborationOperationsState> {
  switch (intent.type) {
    case "collaboration/startRequested":
      return requestOperation(
        state,
        intent.requestId,
        "start",
        intent.input.workspaceId,
        (requestId) => ({
          commandId: `collaboration:start:${requestId}`,
          correlationId: requestId,
          input: intent.input,
          timeoutMs: COMMAND_TIMEOUT_MS,
          type: "collaboration/start"
        })
      );
    case "collaboration/adoptionRequested":
      return requestOperation(
        state,
        intent.requestId,
        "adoption",
        intent.input.workspaceId,
        (requestId) => ({
          commandId: `collaboration:adoption:${requestId}`,
          correlationId: requestId,
          input: intent.input,
          timeoutMs: COMMAND_TIMEOUT_MS,
          type: "collaboration/setAdoption"
        })
      );
    case "collaboration/cancelRequested":
      return requestOperation(
        state,
        intent.requestId,
        "cancel",
        intent.input.workspaceId,
        (requestId) => ({
          commandId: `collaboration:cancel:${requestId}`,
          correlationId: requestId,
          input: intent.input,
          timeoutMs: COMMAND_TIMEOUT_MS,
          type: "collaboration/cancel"
        })
      );
    case "collaboration/retryRequested":
      return requestOperation(
        state,
        intent.requestId,
        "retry",
        intent.input.workspaceId,
        (requestId) => ({
          commandId: `collaboration:retry:${requestId}`,
          correlationId: requestId,
          input: intent.input,
          timeoutMs: COMMAND_TIMEOUT_MS,
          type: "collaboration/retry"
        })
      );
    case "collaboration/operationDismissed": {
      const requestId = intent.requestId.trim();
      if (!requestId || !state.byRequestId[requestId]) return unchanged(state);
      const byRequestId = { ...state.byRequestId };
      delete byRequestId[requestId];
      return result({ byRequestId });
    }
    case "engine/commandResult":
      return settleOperation(state, intent);
    default:
      return unchanged(state);
  }
}

function requestOperation(
  state: CollaborationOperationsState,
  rawRequestId: string,
  operation: CollaborationOperationKind,
  rawWorkspaceId: string,
  createCommand: (requestId: string) => CollaborationOperationsCommand
): EngineReducerResult<CollaborationOperationsState> {
  const requestId = rawRequestId.trim();
  const workspaceId = rawWorkspaceId.trim();
  if (!requestId || !workspaceId || state.byRequestId[requestId]) {
    return unchanged(state);
  }
  const command = createCommand(requestId);
  const record: CollaborationOperationRecord = {
    errorCode: null,
    errorMessage: null,
    operation,
    requestId,
    result: null,
    status: "inFlight",
    workspaceId
  };
  return {
    commands: [command],
    state: {
      byRequestId: { ...state.byRequestId, [requestId]: record }
    }
  };
}

function settleOperation(
  state: CollaborationOperationsState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<CollaborationOperationsState> {
  if (!intent.commandType.startsWith("collaboration/")) {
    return unchanged(state);
  }
  const requestId = intent.correlationId?.trim() ?? "";
  const current = state.byRequestId[requestId];
  if (
    !current ||
    intent.commandId !== `collaboration:${current.operation}:${requestId}`
  ) {
    return unchanged(state);
  }
  const succeeded = intent.outcome === "succeeded";
  const next: CollaborationOperationRecord = {
    ...current,
    errorCode: succeeded ? null : (intent.errorCode ?? null),
    errorMessage: succeeded ? null : (intent.errorMessage?.trim() ?? null),
    result: succeeded ? collaborationRun(intent.value) : null,
    status: succeeded
      ? "succeeded"
      : intent.outcome === "timedOut"
        ? "unknown"
        : "failed"
  };
  return result({
    byRequestId: { ...state.byRequestId, [requestId]: next }
  });
}

function collaborationRun(
  value: unknown
): AgentActivityCollaborationRun | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<AgentActivityCollaborationRun>;
  return typeof record.id === "string" && typeof record.workspaceId === "string"
    ? (record as AgentActivityCollaborationRun)
    : null;
}

function result(
  state: CollaborationOperationsState
): EngineReducerResult<CollaborationOperationsState> {
  return { commands: NO_COMMANDS, state };
}

function unchanged(
  state: CollaborationOperationsState
): EngineReducerResult<CollaborationOperationsState> {
  return { commands: NO_COMMANDS, state };
}
