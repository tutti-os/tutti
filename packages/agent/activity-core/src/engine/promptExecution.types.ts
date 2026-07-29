import type { PromptQueueSendCommand } from "./promptQueue.types.ts";

export interface PromptExecutionRequestedIntent {
  type: "prompt/executionRequested";
  command: PromptQueueSendCommand;
  workspaceId: string;
}

export type PromptExecutionIntent = PromptExecutionRequestedIntent;

export interface PromptSettingsExecutionRecord {
  promptCommand: PromptQueueSendCommand;
  settingsCommandId: string;
}

export interface PromptExecutionState {
  recordsBySettingsCommandId: Readonly<
    Record<string, PromptSettingsExecutionRecord>
  >;
}
