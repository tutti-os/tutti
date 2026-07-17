import type {
  AgentActivitySubmitDiagnostics,
  AgentActivitySubmitSettingsPatch,
  AgentPromptContentBlock
} from "../types.ts";

export interface EngineQueuedPrompt {
  clientSubmitId?: string;
  content: readonly AgentPromptContentBlock[];
  createdAtUnixMs: number;
  displayPrompt?: string;
  guidance?: boolean;
  id: string;
  requiredSettingsPatch?: Readonly<AgentActivitySubmitSettingsPatch>;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  runtimeContent?: readonly AgentPromptContentBlock[];
  visibleInQueue?: boolean;
}

export type PromptQueueSuspendReason = "user_stop";

export interface PromptQueueInFlightCommand {
  commandId: string;
  /** Set when the command was dispatched as an active-turn steer. */
  guidance?: true;
  kind: "send";
  promptId: string;
  runtimeContent?: readonly AgentPromptContentBlock[];
}

export interface PromptQueueRecord {
  agentSessionId: string;
  deliveryBarrierTurnId: string | null;
  failedPromptId: string | null;
  failureMessage: string | null;
  inFlight: PromptQueueInFlightCommand | null;
  prompts: readonly EngineQueuedPrompt[];
  sendNextPromptId: string | null;
  suspendReason: PromptQueueSuspendReason | null;
  uncertainDelivery: PromptQueueInFlightCommand | null;
  workspaceId: string;
}

export interface PromptQueueState {
  nextCommandSequence: number;
  recordsBySessionId: Readonly<Record<string, PromptQueueRecord>>;
}

export interface PromptQueueEnqueuedIntent {
  type: "queue/enqueued";
  agentSessionId: string;
  prompt: EngineQueuedPrompt;
  workspaceId: string;
}

export interface PromptQueueRemovedIntent {
  type: "queue/removed";
  agentSessionId: string;
  promptId: string;
}

export interface PromptQueueSendNowRequestedIntent {
  type: "queue/sendNowRequested";
  agentSessionId: string;
  cancelCommandId: string;
  promptId: string;
  awaitingTurnExpiresAtUnixMs: number;
  timeoutMs: number;
}

export interface PromptQueueSuspendedIntent {
  type: "queue/suspended";
  agentSessionId: string;
  reason: PromptQueueSuspendReason;
}

export interface PromptQueueResumedIntent {
  type: "queue/resumed";
  agentSessionId: string;
}

export interface PromptQueueSessionCleanedIntent {
  type: "queue/sessionCleaned";
  agentSessionId: string;
}

export type PromptQueueIntent =
  | PromptQueueEnqueuedIntent
  | PromptQueueSendNowRequestedIntent
  | PromptQueueRemovedIntent
  | PromptQueueResumedIntent
  | PromptQueueSessionCleanedIntent
  | PromptQueueSuspendedIntent;

export interface PromptQueueSendCommand {
  type: "queue/sendPrompt";
  agentSessionId: string;
  commandId: string;
  clientSubmitId: string;
  correlationId?: string;
  content: readonly AgentPromptContentBlock[];
  displayPrompt?: string;
  guidance?: boolean;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  promptId: string;
  requiredSettingsPatch?: Readonly<AgentActivitySubmitSettingsPatch>;
  timeoutMs?: number;
  workspaceId: string;
}
