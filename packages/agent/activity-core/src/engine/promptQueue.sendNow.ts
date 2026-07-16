import type { CanonicalSubmitAvailability } from "./sessionLifecycle.availability.ts";
import type { PromptQueueState } from "./promptQueue.types.ts";

export type PromptQueueSendNowStrategy =
  | "send_available"
  | "native_guidance"
  | "cancel_then_send";

interface ActiveTurnDeliveryCapabilities {
  activeTurnGuidance?: boolean;
  interrupt?: boolean;
}

export function resolveQueuedPromptSendNowStrategy(
  state: PromptQueueState,
  rawAgentSessionId: string,
  rawPromptId: string,
  availability: CanonicalSubmitAvailability,
  capabilities: ActiveTurnDeliveryCapabilities | null | undefined
): PromptQueueSendNowStrategy | null {
  const agentSessionId = rawAgentSessionId.trim();
  const promptId = rawPromptId.trim();
  if (!canRequestQueuedPromptSendNow(state, agentSessionId, promptId)) {
    return null;
  }
  return resolvePromptSendNowStrategy(availability, capabilities);
}

export function resolvePromptSendNowStrategy(
  availability: CanonicalSubmitAvailability,
  capabilities: ActiveTurnDeliveryCapabilities | null | undefined
): PromptQueueSendNowStrategy | null {
  if (availability.state === "available") {
    return "send_available";
  }
  if (
    availability.state !== "blocked" ||
    availability.reason !== "active_turn"
  ) {
    return null;
  }
  if (capabilities?.activeTurnGuidance === true) {
    return "native_guidance";
  }
  return capabilities?.interrupt === true ? "cancel_then_send" : null;
}

export function canRequestQueuedPromptSendNow(
  state: PromptQueueState,
  rawAgentSessionId: string,
  rawPromptId: string
): boolean {
  const agentSessionId = rawAgentSessionId.trim();
  const promptId = rawPromptId.trim();
  const current = state.recordsBySessionId[agentSessionId];
  return Boolean(
    current &&
    promptId &&
    current.inFlight?.promptId !== promptId &&
    current.uncertainDelivery?.promptId !== promptId &&
    current.prompts.some((prompt) => prompt.id === promptId)
  );
}
