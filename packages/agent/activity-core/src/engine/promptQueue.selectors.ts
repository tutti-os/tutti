import type { AgentSessionEngineState } from "./types.ts";
import type {
  EngineQueuedPrompt,
  PromptQueueRecord
} from "./promptQueue.types.ts";

export function selectEnginePromptQueue(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): PromptQueueRecord | null {
  const id = agentSessionId?.trim() ?? "";
  return state.promptQueue.recordsBySessionId[id] ?? null;
}

export function selectEngineQueuedPrompts(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): readonly EngineQueuedPrompt[] {
  return selectEnginePromptQueue(state, agentSessionId)?.prompts ?? [];
}

export function selectEngineHasQueuedPrompts(
  state: AgentSessionEngineState
): boolean {
  return Object.values(state.promptQueue.recordsBySessionId).some(
    (record) => record.prompts.length > 0
  );
}

export function selectEngineQueuedPrompt(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  promptId: string | null | undefined
): EngineQueuedPrompt | null {
  const id = promptId?.trim() ?? "";
  return (
    selectEngineQueuedPrompts(state, agentSessionId).find(
      (prompt) => prompt.id === id
    ) ?? null
  );
}

export function selectEnginePromptQueueError(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): string | null {
  return selectEnginePromptQueue(state, agentSessionId)?.failureMessage ?? null;
}

export function selectEngineHasVisibleQueuedSubmit(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  clientSubmitId: string | null | undefined
): boolean {
  const id = clientSubmitId?.trim() ?? "";
  return selectEngineQueuedPrompts(state, agentSessionId).some(
    (prompt) => prompt.clientSubmitId === id && prompt.visibleInQueue !== false
  );
}
