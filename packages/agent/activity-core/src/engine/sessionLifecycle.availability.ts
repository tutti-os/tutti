import type { SessionLifecycleState } from "./sessionLifecycle.types.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";
import type { AgentSessionEngineState } from "./types.ts";
import {
  isPendingActivationViable,
  type PendingActivationIntentRecord
} from "./pendingIntents.types.ts";
import { selectLatestActivationForSession } from "./pendingIntents.selectors.ts";
import { selectEngineSessionReconcile } from "./sessionReconcile.selectors.ts";

export interface CanonicalSubmitAvailability {
  reason?: "active_turn" | "waiting";
  state: "available" | "blocked" | "missing";
}

export type CanonicalSessionLifecycleView = Pick<
  SessionLifecycleState,
  "interactionsById" | "sessionsById" | "turnsById"
>;

/** Single frontend session availability vocabulary for consumers. */
export type SessionAvailabilityStatus =
  | "creating"
  | "available"
  | "loading"
  | "missing"
  | "failed"
  | "deleted";

export function deriveCanonicalSubmitAvailability(
  lifecycle: CanonicalSessionLifecycleView,
  rawAgentSessionId: string | null | undefined
): CanonicalSubmitAvailability {
  const agentSessionId = rawAgentSessionId?.trim() ?? "";
  const session = lifecycle.sessionsById[agentSessionId];
  if (!session) {
    return { state: "missing" };
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

/**
 * Derives session availability without wall-clock guards. Activation expiry is
 * owned by engine expiry intents; viable pending create uses status only.
 */
export function selectSessionAvailability(
  state: AgentSessionEngineState,
  rawAgentSessionId: string | null | undefined
): SessionAvailabilityStatus {
  const agentSessionId = rawAgentSessionId?.trim() ?? "";
  if (!agentSessionId) return "missing";
  if (state.sessionLifecycle.deletedSessionIds[agentSessionId]) {
    return "deleted";
  }
  const activation = selectLatestActivationForSession(state, agentSessionId);
  if (activation && isCreatingActivation(activation)) {
    return "creating";
  }
  if (
    activation?.status === "failed" &&
    !state.sessionLifecycle.sessionsById[agentSessionId]
  ) {
    return "failed";
  }
  const session = state.sessionLifecycle.sessionsById[agentSessionId];
  const reconcile = selectEngineSessionReconcile(state, agentSessionId);
  const loading =
    Boolean(reconcile?.inFlightCommandId) ||
    Boolean(reconcile?.pendingMessages) ||
    Boolean(reconcile?.pendingState);
  if (!session) {
    if (loading) return "loading";
    return "missing";
  }
  if (loading && !reconcile?.messagesHydrated) {
    return "loading";
  }
  return "available";
}

function isCreatingActivation(
  activation: PendingActivationIntentRecord
): boolean {
  return (
    activation.mode === "new" &&
    isPendingActivationViable(activation) &&
    (activation.status === "requested" || activation.status === "uncertain")
  );
}
