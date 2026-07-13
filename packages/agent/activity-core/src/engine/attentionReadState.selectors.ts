import type { AgentSessionEngineState } from "./types.ts";
import type { AttentionReadPartition } from "./attentionReadState.types.ts";

export function selectSessionAttention(
  state: AgentSessionEngineState,
  userId: string | null | undefined,
  agentSessionId: string | null | undefined
) {
  const id = agentSessionId?.trim() ?? "";
  const user = userId?.trim() ?? "";
  return (
    state.attentionReadState.partitionsByUserId[user]?.recordsBySessionId[id] ??
    null
  );
}

export function selectAttentionReadState(
  state: AgentSessionEngineState,
  userId: string | null | undefined
): AttentionReadPartition {
  const user = userId?.trim() ?? "";
  return (
    state.attentionReadState.partitionsByUserId[user] ?? {
      hydrated: null,
      lastError: null,
      recordsBySessionId: {},
      workspaceId: null,
      writeDirty: false,
      writeInFlightCommandId: null,
      writeRevision: 0
    }
  );
}
