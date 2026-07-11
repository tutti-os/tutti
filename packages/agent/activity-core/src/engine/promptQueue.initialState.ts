import type { PromptQueueState } from "./promptQueue.types.ts";

export function createInitialPromptQueueState(): PromptQueueState {
  return {
    availabilityBySessionId: {},
    nextCommandSequence: 1,
    recordsBySessionId: {}
  };
}
