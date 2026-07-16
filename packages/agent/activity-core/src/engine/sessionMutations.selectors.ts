import type { AgentSessionEngineState } from "./types.ts";

export function selectSessionMutation(
  state: AgentSessionEngineState,
  mutationId: string
) {
  return state.sessionMutations.byMutationId[mutationId.trim()] ?? null;
}

export function selectSessionMutations(state: AgentSessionEngineState) {
  return Object.values(state.sessionMutations.byMutationId);
}
