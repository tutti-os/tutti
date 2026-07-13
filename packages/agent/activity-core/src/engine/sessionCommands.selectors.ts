import type { AgentSessionEngineState } from "./types.ts";

export function selectEngineAvailableCommands(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
) {
  const id = agentSessionId?.trim() ?? "";
  const entry = state.sessionCommands.bySessionId[id];
  const session = state.sessionLifecycle.sessionsById[id];
  return entry && session?.workspaceId === entry.workspaceId
    ? entry.commands
    : [];
}
