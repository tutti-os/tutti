import type { PromptQueueState } from "./promptQueue.types.ts";

export function promptQueuePromptIdForClientSubmit(
  state: PromptQueueState,
  agentSessionId: string,
  clientSubmitId: string
): string | null {
  return (
    state.recordsBySessionId[agentSessionId.trim()]?.prompts.find(
      (prompt) => prompt.clientSubmitId === clientSubmitId.trim()
    )?.id ?? null
  );
}

export function canCancelQueuedSubmit(
  state: PromptQueueState,
  agentSessionId: string,
  clientSubmitId: string
): boolean {
  const record = state.recordsBySessionId[agentSessionId.trim()];
  const promptId = promptQueuePromptIdForClientSubmit(
    state,
    agentSessionId,
    clientSubmitId
  );
  return Boolean(
    record &&
    promptId &&
    record.inFlight?.promptId !== promptId &&
    record.uncertainDelivery?.promptId !== promptId
  );
}

export function isQueuedSubmitDeliveryPending(
  state: PromptQueueState,
  agentSessionId: string,
  clientSubmitId: string
): boolean {
  const record = state.recordsBySessionId[agentSessionId.trim()];
  const promptId = promptQueuePromptIdForClientSubmit(
    state,
    agentSessionId,
    clientSubmitId
  );
  return Boolean(
    record &&
    promptId &&
    record.failedPromptId !== promptId &&
    record.uncertainDelivery?.promptId !== promptId
  );
}
