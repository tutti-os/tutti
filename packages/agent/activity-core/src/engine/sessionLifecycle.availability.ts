import type { SessionLifecycleState } from "./sessionLifecycle.types.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";

export interface CanonicalSubmitAvailability {
  reason?:
    | "active_turn"
    | "agent_capability_checking"
    | "agent_capability_unavailable"
    | "waiting"
    | "transport_reconnecting"
    | "transport_unavailable";
  state: "available" | "blocked" | "missing";
}

export type CanonicalSessionLifecycleView = Pick<
  SessionLifecycleState,
  "interactionsById" | "operationBySessionId" | "sessionsById" | "turnsById"
>;

export function deriveCanonicalSubmitAvailability(
  lifecycle: CanonicalSessionLifecycleView,
  rawAgentSessionId: string | null | undefined
): CanonicalSubmitAvailability {
  const agentSessionId = rawAgentSessionId?.trim() ?? "";
  const session = lifecycle.sessionsById[agentSessionId];
  if (!session) {
    return { state: "missing" };
  }
  const runtimeAvailability =
    lifecycle.operationBySessionId[agentSessionId]?.runtimeAvailability;
  if (runtimeAvailability?.state === "blocked") {
    return { state: "blocked", reason: runtimeAvailability.reason };
  }
  if (
    Object.values(lifecycle.interactionsById).some(
      (interaction) =>
        interaction.agentSessionId === agentSessionId &&
        interaction.status === "pending"
    )
  ) {
    return { state: "blocked", reason: "waiting" };
  }
  const activeTurn = session.activeTurnId
    ? lifecycle.turnsById[
        canonicalTurnKey(agentSessionId, session.activeTurnId)
      ]
    : undefined;
  if (activeTurn && activeTurn.phase !== "settled") {
    return { state: "blocked", reason: "active_turn" };
  }
  return { state: "available" };
}
