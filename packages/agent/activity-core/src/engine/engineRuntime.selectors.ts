import type { AgentSessionEngineState } from "./types.ts";

export function selectWorkspaceReconcileState(state: AgentSessionEngineState) {
  return state.engineRuntime.workspaceReconcile;
}
