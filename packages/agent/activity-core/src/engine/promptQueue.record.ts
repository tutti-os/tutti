import type { PromptQueueRecord } from "./promptQueue.types.ts";

export function emptyQueueRecord(
  workspaceId: string,
  agentSessionId: string
): PromptQueueRecord {
  return {
    agentSessionId,
    deliveryBarrierTurnId: null,
    failedPromptId: null,
    failureMessage: null,
    inFlight: null,
    prompts: [],
    sendNextPromptId: null,
    suspendReason: null,
    uncertainDelivery: null,
    workspaceId
  };
}

export function compactQueueRecord(
  record: PromptQueueRecord
): PromptQueueRecord | null {
  return record.prompts.length === 0 &&
    !record.inFlight &&
    !record.uncertainDelivery &&
    !record.deliveryBarrierTurnId
    ? null
    : record;
}

export function queueSendCommandId(
  agentSessionId: string,
  sequence: number
): string {
  return `queue:send:${agentSessionId}:${sequence}`;
}
