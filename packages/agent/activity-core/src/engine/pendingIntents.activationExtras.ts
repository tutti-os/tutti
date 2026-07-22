import type { SessionActivationRequestedIntent } from "./pendingIntents.types.ts";

export function pendingActivationGoalControlFields(
  intent: Pick<SessionActivationRequestedIntent, "initialGoalControl">
): {
  initialGoalControl?: SessionActivationRequestedIntent["initialGoalControl"];
} {
  return intent.initialGoalControl
    ? { initialGoalControl: { ...intent.initialGoalControl } }
    : {};
}

export function pendingActivationRailSectionKeyFields(
  intent: Pick<SessionActivationRequestedIntent, "railSectionKey">
): { railSectionKey?: string } {
  const railSectionKey = intent.railSectionKey?.trim();
  return railSectionKey ? { railSectionKey } : {};
}
