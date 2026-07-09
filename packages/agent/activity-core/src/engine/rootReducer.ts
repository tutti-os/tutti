import {
  createInitialEngineRuntimeState,
  engineRuntimeReducer
} from "./engineRuntime.reducer.ts";
import type {
  AgentSessionEngineState,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";

// Root reducer: static composition of domain reducers, zero business logic.
// Each domain owns its slice of the state tree and contributes commands.
// New domains are wired here as refactor slices land (turn lifecycle, queue
// send, optimistic intents, connection/reconcile).

export function createInitialAgentSessionEngineState(): AgentSessionEngineState {
  return {
    engineRuntime: createInitialEngineRuntimeState()
  };
}

export function rootEngineReducer(
  state: AgentSessionEngineState,
  intent: EngineIntent
): EngineReducerResult<AgentSessionEngineState> {
  const engineRuntime = engineRuntimeReducer(state.engineRuntime, intent);
  const nextState =
    engineRuntime.state === state.engineRuntime
      ? state
      : { ...state, engineRuntime: engineRuntime.state };
  return {
    commands: engineRuntime.commands,
    state: nextState
  };
}
