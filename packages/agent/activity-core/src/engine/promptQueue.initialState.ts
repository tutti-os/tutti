import type { PromptQueueState } from "./promptQueue.types.ts";

export function createInitialPromptQueueState(): PromptQueueState {
  return {
    nextCommandSequence: 1,
    recordsBySessionId: {}
  };
}
