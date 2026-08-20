import type {
  AgentActivityCapabilityReference,
  AgentActivitySubmitDiagnostics,
  AgentActivitySubmitSettingsPatch,
  AgentPromptContentBlock
} from "../types.ts";

export interface EngineQueuedPrompt {
  capabilityRefs?: readonly AgentActivityCapabilityReference[];
  clientSubmitId?: string;
  content: readonly AgentPromptContentBlock[];
  createdAtUnixMs: number;
  displayPrompt?: string;
  guidance?: boolean;
  id: string;
  requiredSettingsPatch?: Readonly<AgentActivitySubmitSettingsPatch>;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  /** Exact canonical active Turn targeted by a native guidance send. */
  targetTurnId?: string;
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
  stage?: "preparingSettings" | "sending";
}

export interface PromptQueuePendingSendNow {
  awaitingTurnExpiresAtUnixMs: number;
  cancelCommandId: string;
  promptId: string;
  targetTurnId: string;
  timeoutMs: number;
}

export interface PromptQueueRecord {
  agentSessionId: string;
  deliveryBarrierTurnId: string | null;
  failedPromptId: string | null;
  failureMessage: string | null;
  inFlight: PromptQueueInFlightCommand | null;
  /** Omitted by snapshots produced before deferred send-now admission existed. */
  pendingSendNowByPromptId?: Readonly<
    Record<string, PromptQueuePendingSendNow>
  >;
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
  /** Exact active Turn observed when this deferred intent was admitted. */
  targetTurnId?: string;
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
  capabilityRefs?: readonly AgentActivityCapabilityReference[];
  commandId: string;
  clientSubmitId: string;
  correlationId?: string;
  content: readonly AgentPromptContentBlock[];
  displayPrompt?: string;
  guidance?: boolean;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  /** Exact canonical active Turn targeted by a native guidance send. */
  targetTurnId?: string;
  promptId: string;
  requiredSettingsPatch?: Readonly<AgentActivitySubmitSettingsPatch>;
  timeoutMs?: number;
  workspaceId: string;
}
