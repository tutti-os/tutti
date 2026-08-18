import type { AgentActivityTurn } from "../types.ts";

export function compareTurnsByOccurrence(
  left: AgentActivityTurn,
  right: AgentActivityTurn
): number {
  return (
    left.startedAtUnixMs - right.startedAtUnixMs ||
    left.turnId.localeCompare(right.turnId)
  );
}

export function latestTurnForSession(
  turnsById: Readonly<Record<string, AgentActivityTurn>>,
  rawAgentSessionId: string
): AgentActivityTurn | null {
  const agentSessionId = rawAgentSessionId.trim();
  if (!agentSessionId) return null;

  let latestTurn: AgentActivityTurn | null = null;
  for (const turn of Object.values(turnsById)) {
    if (
      turn.agentSessionId.trim() === agentSessionId &&
      (!latestTurn || compareTurnsByOccurrence(latestTurn, turn) < 0)
    ) {
      latestTurn = turn;
    }
  }
  return latestTurn;
}
