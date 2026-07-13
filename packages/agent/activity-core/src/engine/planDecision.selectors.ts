import type { AgentSessionEngineState } from "./types.ts";

export function selectPlanDecisionForTurn(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  turnId: string | null | undefined
) {
  const sessionId = agentSessionId?.trim() ?? "";
  const id = turnId?.trim() ?? "";
  return (
    Object.values(state.planDecisions.byId).find(
      (record) => record.agentSessionId === sessionId && record.turnId === id
    ) ?? null
  );
}

export function selectPlanTurnDismissed(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  turnId: string | null | undefined
): boolean {
  const sessionId = agentSessionId?.trim() ?? "";
  const id = turnId?.trim() ?? "";
  return state.planDecisions.dismissedByTurnKey[`${sessionId}\0${id}`] === true;
}
