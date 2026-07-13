import type { AgentActivitySessionInput } from "../sessionNormalization.ts";
import type {
  PromptQueueAvailability,
  PromptQueueInFlightCommand
} from "./promptQueue.types.ts";

export function promptQueueAvailabilityFromSession(
  session: AgentActivitySessionInput
): PromptQueueAvailability {
  const activeTurnId = session.activeTurnId?.trim() || null;
  const activeTurn =
    activeTurnId && session.activeTurn?.turnId === activeTurnId
      ? session.activeTurn
      : null;
  const hasPendingInteraction = (session.pendingInteractions ?? []).some(
    (interaction) =>
      interaction.status === "pending" &&
      interaction.turnId === activeTurnId &&
      interaction.agentSessionId === session.agentSessionId
  );
  const turnIsLive = Boolean(activeTurn && activeTurn.phase !== "settled");
  const observedTurn = session.activeTurn ?? null;
  return {
    activeTurnId,
    lastTurnId: observedTurn?.turnId ?? null,
    lastTurnVersion: observedTurn?.updatedAtUnixMs ?? null,
    sessionVersion: activityVersion(session),
    state:
      activeTurnId && (!activeTurn || turnIsLive || hasPendingInteraction)
        ? "blocked"
        : "available"
  };
}

export function promptQueueAvailabilityEqual(
  left: PromptQueueAvailability,
  right: PromptQueueAvailability
): boolean {
  return (
    left.activeTurnId === right.activeTurnId &&
    left.lastTurnId === right.lastTurnId &&
    left.lastTurnVersion === right.lastTurnVersion &&
    left.sessionVersion === right.sessionVersion &&
    left.state === right.state
  );
}

export function promptQueueAvailabilityMapsEqual(
  left: Readonly<Record<string, PromptQueueAvailability>>,
  right: Readonly<Record<string, PromptQueueAvailability>>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        right[key] && promptQueueAvailabilityEqual(left[key]!, right[key]!)
    )
  );
}

export function shouldAcceptPromptQueueAvailability(
  current: PromptQueueAvailability,
  incoming: PromptQueueAvailability
): boolean {
  if (incoming.state === "missing") {
    return true;
  }
  if (
    current.sessionVersion !== null &&
    incoming.sessionVersion !== null &&
    incoming.sessionVersion < current.sessionVersion
  ) {
    return false;
  }
  if (
    current.activeTurnId !== null &&
    incoming.activeTurnId !== current.activeTurnId &&
    current.sessionVersion !== null &&
    incoming.sessionVersion !== null &&
    incoming.sessionVersion <= current.sessionVersion
  ) {
    return false;
  }
  return !(
    current.lastTurnId !== null &&
    current.lastTurnId === incoming.lastTurnId &&
    current.lastTurnVersion !== null &&
    incoming.lastTurnVersion !== null &&
    incoming.lastTurnVersion < current.lastTurnVersion
  );
}

export function carryPromptQueueObservedTurnForward(
  current: PromptQueueAvailability,
  incoming: PromptQueueAvailability
): PromptQueueAvailability {
  if (incoming.state === "missing" || incoming.lastTurnId !== null) {
    return incoming;
  }
  return {
    ...incoming,
    lastTurnId: current.lastTurnId,
    lastTurnVersion: current.lastTurnVersion
  };
}

export function observedSettledTurnAfterQueueSend(
  availability: PromptQueueAvailability,
  inFlight: PromptQueueInFlightCommand
): boolean {
  return (
    availability.state === "available" &&
    observedTurnAfterQueueSend(availability, inFlight)
  );
}

function observedTurnAfterQueueSend(
  availability: PromptQueueAvailability,
  inFlight: PromptQueueInFlightCommand
): boolean {
  if (
    availability.lastTurnId === null ||
    availability.lastTurnVersion === null
  ) {
    return false;
  }
  return (
    availability.lastTurnId !== inFlight.startedLastTurnId ||
    inFlight.startedLastTurnVersion === null ||
    availability.lastTurnVersion > inFlight.startedLastTurnVersion
  );
}

function activityVersion(session: AgentActivitySessionInput): number | null {
  const versions = [
    session.updatedAtUnixMs ??
      session.lastEventUnixMs ??
      session.messageVersion ??
      session.createdAtUnixMs ??
      session.startedAtUnixMs,
    session.activeTurn?.updatedAtUnixMs,
    ...(session.pendingInteractions ?? []).map(
      (interaction) => interaction.updatedAtUnixMs
    )
  ].filter((value): value is number => typeof value === "number");
  return versions.length > 0 ? Math.max(...versions) : null;
}
