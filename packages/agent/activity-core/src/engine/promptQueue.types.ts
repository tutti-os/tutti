import type {
  AgentActivitySubmitDiagnostics,
  AgentPromptContentBlock
} from "../types.ts";

export interface EngineQueuedPrompt {
  clientSubmitId?: string;
  content: readonly AgentPromptContentBlock[];
  createdAtUnixMs: number;
  displayPrompt?: string;
  guidance?: boolean;
  id: string;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  runtimeContent?: readonly AgentPromptContentBlock[];
  visibleInQueue?: boolean;
}

export type PromptQueueSuspendReason = "user_stop";

export interface PromptQueueAvailability {
  activeTurnId: string | null;
  lastTurnId: string | null;
  lastTurnVersion: number | null;
  sessionVersion: number | null;
  state: "available" | "blocked" | "missing";
}

export interface PromptQueueInFlightCommand {
  commandId: string;
  kind: "send";
  promptId: string;
  runtimeContent?: readonly AgentPromptContentBlock[];
  startedLastTurnId: string | null;
  startedLastTurnVersion: number | null;
}

export interface PromptQueueRecord {
  agentSessionId: string;
  availability: PromptQueueAvailability;
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
  availabilityBySessionId: Readonly<Record<string, PromptQueueAvailability>>;
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

export interface PromptQueuePromotedIntent {
  type: "queue/promoted";
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
  | PromptQueuePromotedIntent
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
  timeoutMs?: number;
  workspaceId: string;
}
