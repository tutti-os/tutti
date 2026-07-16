import type {
  AgentActivityCapabilityReference,
  AgentActivityInitialGoalControl,
  AgentActivityInitialTuttiModeActivation,
  AgentActivityMessage,
  AgentActivitySessionSettings,
  AgentActivitySubmitDiagnostics,
  AgentActivitySubmitSettingsPatch,
  AgentPromptContentBlock
} from "../types.ts";

export type PendingActivationStatus =
  | "requested"
  | "confirmed"
  | "canceled"
  | "uncertain"
  | "failed";

/** True while an activation may still yield, or already yielded, a session. */
export function isPendingActivationViable(
  activation: { status: PendingActivationStatus } | null | undefined
): boolean {
  return (
    activation !== null &&
    activation !== undefined &&
    activation.status !== "failed" &&
    activation.status !== "canceled"
  );
}

interface PendingActivationIntentRecordBase {
  agentSessionId: string;
  capabilityRefs?: readonly AgentActivityCapabilityReference[];
  content: readonly AgentPromptContentBlock[];
  displayPrompt?: string;
  cwd: string;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAtUnixMs: number;
  initialTurnExpected: boolean;
  initialGoalControl?: Readonly<AgentActivityInitialGoalControl>;
  railSectionKey?: string;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  pendingSettingsPatch?: Readonly<Record<string, unknown>>;
  settingsUpdateStatus?: "failed" | "inFlight" | "unknown";
  requestedAtUnixMs: number;
  requestId: string;
  settings?: AgentActivitySessionSettings;
  status: PendingActivationStatus;
  title: string | null;
  workspaceId: string;
  initialTuttiModeActivation?: AgentActivityInitialTuttiModeActivation;
  tuttiModeDraftKey?: string;
}

export type PendingActivationIntentRecord =
  | (PendingActivationIntentRecordBase & {
      agentTargetId: string;
      clientSubmitId: string;
      mode: "new";
      optimisticTitle?: string;
    })
  | (PendingActivationIntentRecordBase & {
      agentTargetId: string | null;
      clientSubmitId: null;
      mode: "existing";
      optimisticTitle?: never;
    });

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
  capabilityRefs?: readonly AgentActivityCapabilityReference[];
  content: readonly AgentPromptContentBlock[];
  displayPrompt?: string;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAtUnixMs: number;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  requestedAtUnixMs: number;
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

interface SessionActivationRequestedIntentBase {
  type: "activation/requested";
  agentSessionId: string;
  capabilityRefs?: readonly AgentActivityCapabilityReference[];
  content?: readonly AgentPromptContentBlock[];
  cwd?: string;
  expiresAtUnixMs: number;
  initialTurnExpected?: boolean;
  initialGoalControl?: Readonly<AgentActivityInitialGoalControl>;
  railSectionKey?: string;
  initialDisplayPrompt?: string;
  runtimeContent?: readonly AgentPromptContentBlock[];
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  requestedAtUnixMs: number;
  requestId: string;
  settings?: AgentActivitySessionSettings;
  title?: string;
  visible?: boolean;
  workspaceId: string;
  initialTuttiModeActivation?: AgentActivityInitialTuttiModeActivation;
  tuttiModeDraftKey?: string;
}

export type SessionActivationRequestedIntent =
  | (SessionActivationRequestedIntentBase & {
      agentTargetId: string;
      clientSubmitId: string;
      mode: "new";
      optimisticTitle?: string;
    })
  | (SessionActivationRequestedIntentBase & {
      agentTargetId?: string | null;
      clientSubmitId?: never;
      mode: "existing";
      optimisticTitle?: never;
    });

export interface SessionActivationDismissedIntent {
  type: "activation/dismissed";
  requestId: string;
}

export interface SessionActivationSettingsPatchedIntent {
  type: "activation/settingsPatched";
  agentSessionId: string;
  settings: Readonly<Record<string, unknown>>;
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

interface SessionActivateCommandBase {
  type: "session/activate";
  agentSessionId: string;
  capabilityRefs?: readonly AgentActivityCapabilityReference[];
  commandId: string;
  correlationId: string;
  cwd?: string;
  initialContent?: readonly AgentPromptContentBlock[];
  initialDisplayPrompt?: string;
  initialGoalControl?: Readonly<AgentActivityInitialGoalControl>;
  initialTuttiModeActivation?: AgentActivityInitialTuttiModeActivation;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  settings?: AgentActivitySessionSettings;
  timeoutMs?: number;
  title?: string;
  visible?: boolean;
  workspaceId: string;
}

export type SessionActivateCommand =
  | (SessionActivateCommandBase & {
      agentTargetId: string;
      clientSubmitId: string;
      mode: "new";
    })
  | (SessionActivateCommandBase & {
      agentTargetId?: string | null;
      clientSubmitId?: never;
      mode: "existing";
    });

export interface SessionUnactivateCommand {
  type: "session/unactivate";
  agentSessionId: string;
  commandId: string;
  workspaceId: string;
}

export interface SessionUpdateSettingsCommand {
  type: "session/updateSettings";
  agentSessionId: string;
  commandId: string;
  correlationId: string;
  settings: Readonly<Record<string, unknown>>;
  workspaceId: string;
}

export interface SubmitRequestedIntent {
  type: "submit/requested";
  agentSessionId: string;
  clientSubmitId: string;
  capabilityRefs?: readonly AgentActivityCapabilityReference[];
  content: readonly AgentPromptContentBlock[];
  displayPrompt?: string;
  expiresAtUnixMs: number;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  requestedAtUnixMs: number;
  requiredSettingsPatch?: Readonly<AgentActivitySubmitSettingsPatch>;
  routing?: "auto" | "immediate" | "send_now";
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
  | SessionActivationSettingsPatchedIntent
  | SessionActivationFailureClearedIntent
  | SessionActivationFailureRecordedIntent
  | SessionActivationRequestedIntent
  | SessionUnactivationRequestedIntent
  | SubmitCanceledIntent
  | SubmitDismissedIntent
  | SubmitRequestedIntent;
