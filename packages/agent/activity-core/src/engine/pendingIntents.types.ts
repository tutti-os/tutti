import type {
  AgentActivityMessage,
  AgentActivitySendInputResult,
  AgentActivitySession,
  AgentPromptContentBlock
} from "../types.ts";

export type PendingActivationStatus =
  | "requested"
  | "confirmed"
  | "uncertain"
  | "failed";

export interface AgentSessionActivationResult {
  activation: {
    status: string;
  };
  error?: {
    code?: string;
    message?: string;
  } | null;
  session: AgentActivitySession;
}

export interface PendingActivationIntentRecord {
  agentSessionId: string;
  agentTargetId: string | null;
  clientSubmitId: string | null;
  content: readonly AgentPromptContentBlock[];
  cwd: string;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAtUnixMs: number;
  metadata?: Readonly<Record<string, unknown>>;
  mode: "existing" | "new";
  requestedAtUnixMs: number;
  requestId: string;
  result: AgentSessionActivationResult | null;
  settings?: Readonly<Record<string, unknown>>;
  status: PendingActivationStatus;
  title: string | null;
  workspaceId: string;
}

export type PendingSubmitStatus =
  | "requested"
  | "accepted"
  | "confirmed"
  | "uncertain"
  | "failed";

export interface PendingSubmitIntentRecord {
  acceptedSessionVersion: number | null;
  agentSessionId: string;
  clientSubmitId: string;
  content: readonly AgentPromptContentBlock[];
  displayPrompt?: string;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAtUnixMs: number;
  guidance: boolean;
  metadata?: Readonly<Record<string, unknown>>;
  requestedAtUnixMs: number;
  result: AgentActivitySendInputResult | null;
  status: PendingSubmitStatus;
  turnId: string | null;
  workspaceId: string;
}

export interface PendingIntentsState {
  activationsByRequestId: Readonly<
    Record<string, PendingActivationIntentRecord>
  >;
  inactiveSessionIds: Readonly<Record<string, true>>;
  submitsByClientSubmitId: Readonly<Record<string, PendingSubmitIntentRecord>>;
}

export interface SessionActivationRequestedIntent {
  type: "activation/requested";
  agentSessionId: string;
  agentTargetId?: string | null;
  clientSubmitId?: string | null;
  content?: readonly AgentPromptContentBlock[];
  cwd?: string;
  expiresAtUnixMs: number;
  initialDisplayPrompt?: string;
  metadata?: Readonly<Record<string, unknown>>;
  mode: "existing" | "new";
  openclawGatewayReady?: boolean;
  requestedAtUnixMs: number;
  requestId: string;
  settings?: Readonly<Record<string, unknown>>;
  title?: string;
  visible?: boolean;
  workspaceId: string;
}

export interface SessionActivationDismissedIntent {
  type: "activation/dismissed";
  requestId: string;
}

export interface SessionActivationFailureRecordedIntent {
  type: "activation/failureRecorded";
  agentSessionId: string;
  errorCode?: string | null;
  errorMessage: string;
  occurredAtUnixMs: number;
  requestId: string;
  workspaceId: string;
}

export interface SessionActivationFailureClearedIntent {
  type: "activation/failureCleared";
  agentSessionId: string;
}

export interface SessionUnactivationRequestedIntent {
  type: "activation/unactivateRequested";
  agentSessionId: string;
  commandId: string;
  workspaceId: string;
}

export interface SessionActivateCommand {
  type: "session/activate";
  agentSessionId: string;
  agentTargetId?: string | null;
  commandId: string;
  correlationId: string;
  cwd?: string;
  initialContent?: readonly AgentPromptContentBlock[];
  initialDisplayPrompt?: string;
  metadata?: Readonly<Record<string, unknown>>;
  mode: "existing" | "new";
  openclawGatewayReady?: boolean;
  settings?: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  title?: string;
  visible?: boolean;
  workspaceId: string;
}

export interface SessionUnactivateCommand {
  type: "session/unactivate";
  agentSessionId: string;
  commandId: string;
  workspaceId: string;
}

export interface SubmitRequestedIntent {
  type: "submit/requested";
  agentSessionId: string;
  clientSubmitId: string;
  content: readonly AgentPromptContentBlock[];
  displayPrompt?: string;
  expiresAtUnixMs: number;
  guidance?: boolean;
  metadata?: Readonly<Record<string, unknown>>;
  requestedAtUnixMs: number;
  routing?: "auto" | "immediate";
  runtimeContent?: readonly AgentPromptContentBlock[];
  workspaceId: string;
}

export interface SubmitDismissedIntent {
  type: "submit/dismissed";
  clientSubmitId: string;
}

export interface SubmitCanceledIntent {
  type: "submit/canceled";
  agentSessionId: string;
  clientSubmitId: string;
}

export interface ActivityMessagesReceivedIntent {
  type: "message/snapshotReceived";
  messages: readonly AgentActivityMessage[];
  workspaceId?: string;
}

export type PendingIntentsIntent =
  | ActivityMessagesReceivedIntent
  | SessionActivationDismissedIntent
  | SessionActivationFailureClearedIntent
  | SessionActivationFailureRecordedIntent
  | SessionActivationRequestedIntent
  | SessionUnactivationRequestedIntent
  | SubmitCanceledIntent
  | SubmitDismissedIntent
  | SubmitRequestedIntent;
