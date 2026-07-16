import type {
  AgentActivityCancelCollaborationInput,
  AgentActivityCollaborationRun,
  AgentActivityRetryCollaborationInput,
  AgentActivitySetCollaborationAdoptionInput,
  AgentActivityStartAgentCollaborationInput
} from "../collaboration.types.ts";

export type CollaborationOperationKind =
  | "start"
  | "adoption"
  | "cancel"
  | "retry";

export type CollaborationOperationStatus =
  | "inFlight"
  | "succeeded"
  | "failed"
  | "unknown";

export interface CollaborationOperationRecord {
  errorCode: string | null;
  errorMessage: string | null;
  operation: CollaborationOperationKind;
  requestId: string;
  result: AgentActivityCollaborationRun | null;
  status: CollaborationOperationStatus;
  workspaceId: string;
}

export interface CollaborationOperationsState {
  byRequestId: Readonly<Record<string, CollaborationOperationRecord>>;
}

export interface CollaborationStartRequestedIntent {
  type: "collaboration/startRequested";
  requestId: string;
  input: Omit<AgentActivityStartAgentCollaborationInput, "signal">;
}

export interface CollaborationAdoptionRequestedIntent {
  type: "collaboration/adoptionRequested";
  requestId: string;
  input: Omit<AgentActivitySetCollaborationAdoptionInput, "signal">;
}

export interface CollaborationCancelRequestedIntent {
  type: "collaboration/cancelRequested";
  requestId: string;
  input: Omit<AgentActivityCancelCollaborationInput, "signal">;
}

export interface CollaborationRetryRequestedIntent {
  type: "collaboration/retryRequested";
  requestId: string;
  input: Omit<AgentActivityRetryCollaborationInput, "signal">;
}

export interface CollaborationOperationDismissedIntent {
  type: "collaboration/operationDismissed";
  requestId: string;
}

export type CollaborationOperationsIntent =
  | CollaborationStartRequestedIntent
  | CollaborationAdoptionRequestedIntent
  | CollaborationCancelRequestedIntent
  | CollaborationRetryRequestedIntent
  | CollaborationOperationDismissedIntent;

export type CollaborationOperationRequestedIntent =
  | CollaborationStartRequestedIntent
  | CollaborationAdoptionRequestedIntent
  | CollaborationCancelRequestedIntent
  | CollaborationRetryRequestedIntent;

interface CollaborationCommandBase {
  commandId: string;
  correlationId: string;
  timeoutMs?: number;
}

export interface CollaborationStartCommand extends CollaborationCommandBase {
  type: "collaboration/start";
  input: Omit<AgentActivityStartAgentCollaborationInput, "signal">;
}

export interface CollaborationAdoptionCommand extends CollaborationCommandBase {
  type: "collaboration/setAdoption";
  input: Omit<AgentActivitySetCollaborationAdoptionInput, "signal">;
}

export interface CollaborationCancelCommand extends CollaborationCommandBase {
  type: "collaboration/cancel";
  input: Omit<AgentActivityCancelCollaborationInput, "signal">;
}

export interface CollaborationRetryCommand extends CollaborationCommandBase {
  type: "collaboration/retry";
  input: Omit<AgentActivityRetryCollaborationInput, "signal">;
}

export type CollaborationOperationsCommand =
  | CollaborationStartCommand
  | CollaborationAdoptionCommand
  | CollaborationCancelCommand
  | CollaborationRetryCommand;
