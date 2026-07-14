import type { SessionReconcileRecord } from "./sessionReconcile.types.ts";
import type { AgentSessionEngineState } from "./types.ts";

export function selectEngineSessionReconcile(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionReconcileRecord | null {
  const id = agentSessionId?.trim() ?? "";
  return id ? (state.sessionReconcile.recordsBySessionId[id] ?? null) : null;
}
