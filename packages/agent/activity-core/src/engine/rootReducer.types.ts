import type {
  PromptExecutionIntent,
  PromptExecutionState
} from "./promptExecution.types.ts";
import type {
  AgentSessionEngineState,
  EngineCommand,
  EngineIntent
} from "./types.ts";

/**
 * Root-reducer-only intents. Hosts dispatch `EngineIntent`; continuations in
 * this union are created and drained entirely inside one Engine instance.
 */
export type RootEngineIntent = EngineIntent | PromptExecutionIntent;

/**
 * Root-reducer-only state. Public snapshots project the host-observable state
 * and omit execution bookkeeping.
 */
export interface RootAgentSessionEngineState extends AgentSessionEngineState {
  promptExecutions: PromptExecutionState;
}

export interface RootEngineReducerResult<TState> {
  commands: readonly EngineCommand[];
  followUpIntents?: readonly RootEngineIntent[];
  state: TState;
}
