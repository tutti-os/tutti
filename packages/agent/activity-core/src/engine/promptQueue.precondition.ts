import type { ScopedSessionResultValidation } from "./commandResult.validation.ts";
import type {
  EngineCommand,
  EngineCommandResultIntent,
  EngineReducerResult
} from "./types.ts";
import type { RootEngineReducerResult } from "./rootReducer.types.ts";
import type {
  PromptQueueSendCommand,
  PromptQueueState
} from "./promptQueue.types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

export function requestPromptExecution(
  state: PromptQueueState,
  command: PromptQueueSendCommand
): RootEngineReducerResult<PromptQueueState> {
  return {
    commands: NO_COMMANDS,
    followUpIntents: [
      {
        command,
        type: "prompt/executionRequested",
        workspaceId: command.workspaceId
      }
    ],
    state
  };
}

export function settlePromptSettingsPrecondition(
  state: PromptQueueState,
  promptCommandId: string,
  intent: EngineCommandResultIntent,
  validation: ScopedSessionResultValidation | null
): EngineReducerResult<PromptQueueState> {
  if (intent.outcome !== "succeeded" || validation?.kind !== "valid") {
    return unchanged(state);
  }
  const entry = Object.entries(state.recordsBySessionId).find(
    ([, record]) =>
      record.inFlight?.commandId === promptCommandId &&
      record.inFlight.stage === "preparingSettings"
  );
  if (!entry) return unchanged(state);
  const [agentSessionId, record] = entry;
  return {
    commands: NO_COMMANDS,
    state: {
      ...state,
      recordsBySessionId: {
        ...state.recordsBySessionId,
        [agentSessionId]: {
          ...record,
          inFlight: {
            ...record.inFlight!,
            stage: "sending"
          }
        }
      }
    }
  };
}

function unchanged(
  state: PromptQueueState
): EngineReducerResult<PromptQueueState> {
  return { commands: NO_COMMANDS, state };
}
