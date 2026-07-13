import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult,
  EngineRuntimeState
} from "./types.ts";

// Engine self state domain: connection placeholder, processed-intent counter,
// and the probe/expiry round trips that drive the skeleton interleaving tests.
// Real business domains (turn lifecycle, queue, optimistic intents) land as
// sibling `*.reducer.ts` files in later slices.

const NO_COMMANDS: readonly EngineCommand[] = [];

export function createInitialEngineRuntimeState(): EngineRuntimeState {
  return {
    connection: "unknown",
    lastCommandResult: null,
    lastExpiredIntentId: null,
    processedIntentCount: 0,
    workspaceReconcile: {
      commandId: null,
      errorCode: null,
      errorMessage: null,
      status: "idle"
    }
  };
}

export function engineRuntimeReducer(
  state: EngineRuntimeState,
  intent: EngineIntent
): EngineReducerResult<EngineRuntimeState> {
  const counted: EngineRuntimeState = {
    ...state,
    processedIntentCount: state.processedIntentCount + 1
  };
  switch (intent.type) {
    case "workspace/reconcileRequested":
      return requestWorkspaceReconcile(
        counted,
        intent.workspaceId,
        intent.retry === true
      );
    case "engine/connectionChanged":
      if (
        intent.status === "connected" &&
        state.connection !== "connected" &&
        intent.workspaceId?.trim()
      ) {
        return requestWorkspaceReconcile(
          { ...counted, connection: intent.status },
          intent.workspaceId,
          true
        );
      }
      return {
        commands: NO_COMMANDS,
        state: { ...counted, connection: intent.status }
      };
    case "engine/probeRequested":
      return {
        commands: [
          {
            commandId: intent.probeId,
            type: "engine/probe",
            ...(intent.timeoutMs === undefined
              ? {}
              : { timeoutMs: intent.timeoutMs })
          }
        ],
        state: counted
      };
    case "engine/expiryRequested":
      return {
        commands: [
          {
            dueAtUnixMs: intent.dueAtUnixMs,
            expiryId: intent.expiryId,
            type: "engine/scheduleExpiry"
          }
        ],
        state: counted
      };
    case "engine/expiryCancelRequested":
      return {
        commands: [{ expiryId: intent.expiryId, type: "engine/cancelExpiry" }],
        state: counted
      };
    case "engine/commandResult":
      if (
        intent.commandType === "engine/reconcileWorkspace" &&
        intent.commandId === state.workspaceReconcile.commandId
      ) {
        return {
          commands: NO_COMMANDS,
          state: {
            ...counted,
            lastCommandResult: commandResultRecord(intent),
            workspaceReconcile: {
              commandId: null,
              errorCode:
                intent.outcome === "failed" ? (intent.errorCode ?? null) : null,
              errorMessage:
                intent.outcome === "failed"
                  ? intent.errorMessage?.trim() || null
                  : null,
              status:
                intent.outcome === "succeeded"
                  ? "ready"
                  : intent.outcome === "failed"
                    ? "failed"
                    : "unknown"
            }
          }
        };
      }
      return {
        commands: NO_COMMANDS,
        state: {
          ...counted,
          lastCommandResult: commandResultRecord(intent)
        }
      };
    case "engine/intentExpired":
      return {
        commands: NO_COMMANDS,
        state: { ...counted, lastExpiredIntentId: intent.expiryId }
      };
    default:
      return { commands: NO_COMMANDS, state: counted };
  }
}

function requestWorkspaceReconcile(
  state: EngineRuntimeState,
  workspaceId: string,
  retry: boolean
): EngineReducerResult<EngineRuntimeState> {
  const normalized = workspaceId.trim();
  if (
    !normalized ||
    state.workspaceReconcile.status === "loading" ||
    ((state.workspaceReconcile.status === "failed" ||
      state.workspaceReconcile.status === "unknown") &&
      !retry)
  )
    return { commands: NO_COMMANDS, state };
  const commandId = `engine:reconcile:${normalized}:${state.processedIntentCount}`;
  return {
    commands: [
      { commandId, type: "engine/reconcileWorkspace", workspaceId: normalized }
    ],
    state: {
      ...state,
      workspaceReconcile: {
        commandId,
        errorCode: null,
        errorMessage: null,
        status: "loading"
      }
    }
  };
}

function commandResultRecord(
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
) {
  return {
    commandId: intent.commandId,
    outcome: intent.outcome,
    ...(intent.errorMessage === undefined
      ? {}
      : { errorMessage: intent.errorMessage })
  };
}
