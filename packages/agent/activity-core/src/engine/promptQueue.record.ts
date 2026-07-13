import type { PromptQueueRecord } from "./promptQueue.types.ts";

export function emptyQueueRecord(
  workspaceId: string,
  agentSessionId: string,
  availability?: PromptQueueRecord["availability"]
): PromptQueueRecord {
  return {
    agentSessionId,
    availability: availability ?? {
      activeTurnId: null,
      lastTurnId: null,
      lastTurnVersion: null,
      sessionVersion: null,
      state: "missing"
    },
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
    !record.uncertainDelivery
    ? null
    : record;
}

export function queueSendCommandId(
  agentSessionId: string,
  sequence: number
): string {
  return `queue:send:${agentSessionId}:${sequence}`;
}
