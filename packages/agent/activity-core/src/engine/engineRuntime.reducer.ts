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
    processedIntentCount: 0
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
    case "engine/connectionChanged":
      if (
        intent.status === "connected" &&
        state.connection !== "connected" &&
        intent.workspaceId?.trim()
      ) {
        return {
          commands: [
            {
              commandId: `engine:reconcile:${intent.workspaceId}:${counted.processedIntentCount}`,
              type: "engine/reconcileWorkspace",
              workspaceId: intent.workspaceId
            }
          ],
          state: { ...counted, connection: intent.status }
        };
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
      return {
        commands: NO_COMMANDS,
        state: {
          ...counted,
          lastCommandResult: {
            commandId: intent.commandId,
            outcome: intent.outcome,
            ...(intent.errorMessage === undefined
              ? {}
              : { errorMessage: intent.errorMessage })
          }
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
