import type {
  PromptQueueState,
  PromptQueueAvailability
} from "./promptQueue.types.ts";

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
  capabilities: ActiveTurnDeliveryCapabilities | null | undefined
): PromptQueueSendNowStrategy | null {
  const agentSessionId = rawAgentSessionId.trim();
  const promptId = rawPromptId.trim();
  if (!canRequestQueuedPromptSendNow(state, agentSessionId, promptId)) {
    return null;
  }
  return resolvePromptSendNowStrategy(state, agentSessionId, capabilities);
}

export function resolvePromptSendNowStrategy(
  state: PromptQueueState,
  rawAgentSessionId: string,
  capabilities: ActiveTurnDeliveryCapabilities | null | undefined
): PromptQueueSendNowStrategy | null {
  const agentSessionId = rawAgentSessionId.trim();
  const availability = resolveAvailability(state, agentSessionId);
  if (!availability) {
    return null;
  }
  if (availability.state === "available") {
    return "send_available";
  }
  if (availability.state !== "blocked" || !availability.activeTurnId) {
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

function resolveAvailability(
  state: PromptQueueState,
  agentSessionId: string
): PromptQueueAvailability | undefined {
  return (
    state.recordsBySessionId[agentSessionId]?.availability ??
    state.availabilityBySessionId[agentSessionId]
  );
}
