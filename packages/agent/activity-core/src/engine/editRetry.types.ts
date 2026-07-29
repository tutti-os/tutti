export type AgentActivityEditRetryRecoveryState =
  | "prepared"
  | "rolling_back"
  | "resend_pending"
  | "recovery_required"
  | "completed";

export type AgentActivityEditRetryRecoveryAction =
  | "reconcile"
  | "retry_replacement";

export type AgentActivityEditRetryReasonCode =
  | "provider_unsupported"
  | "turn_not_found"
  | "turn_not_latest"
  | "turn_not_settled"
  | "history_revision_conflict"
  | "operation_conflict"
  | "recovery_required"
  | "provider_outcome_unknown"
  | "replacement_not_proven_absent";

export interface AgentActivityEditRetryAvailability {
  supported: boolean;
  eligible: boolean;
  turnId?: string;
  historyRevision: number;
  recoveryState: AgentActivityEditRetryRecoveryState;
  operationId?: string;
  availableActions: readonly AgentActivityEditRetryRecoveryAction[];
  reasonCode?: AgentActivityEditRetryReasonCode;
}

export interface AgentActivityEditRetryResult {
  operationId: string;
  state: AgentActivityEditRetryRecoveryState;
  retractedTurnId: string;
  replacementTurnId?: string;
  historyRevision: number;
  reasonCode?: AgentActivityEditRetryReasonCode;
}

export interface AgentActivityEditRetryInput {
  agentSessionId: string;
  clientOperationId: string;
  editedText: string;
  expectedHistoryRevision: number;
  signal?: AbortSignal;
  turnId: string;
  workspaceId: string;
}

export interface AgentActivityRecoverEditRetryInput {
  action: AgentActivityEditRetryRecoveryAction;
  agentSessionId: string;
  operationId: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export type EditRetryOperationStatus =
  | "failed"
  | "idle"
  | "pending"
  | "reconciling"
  | "succeeded";

export interface EditRetryOperationRecord {
  clientOperationId: string | null;
  commandId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestKey: string | null;
  result: AgentActivityEditRetryResult | null;
  status: EditRetryOperationStatus;
  workspaceId: string | null;
}

export interface EditRetryState {
  availabilityBySessionId: Readonly<
    Record<string, AgentActivityEditRetryAvailability>
  >;
  nextCommandSequence: number;
  operationBySessionId: Readonly<Record<string, EditRetryOperationRecord>>;
}

export interface EditRetryAvailabilityReceivedIntent {
  type: "editRetry/availabilityReceived";
  agentSessionId: string;
  availability: AgentActivityEditRetryAvailability;
  workspaceId: string;
}

export interface EditRetryRequestedIntent {
  type: "editRetry/requested";
  agentSessionId: string;
  editedText: string;
  turnId: string;
  workspaceId: string;
}

export interface EditRetryRecoveryRequestedIntent {
  type: "editRetry/recoveryRequested";
  action: AgentActivityEditRetryRecoveryAction;
  agentSessionId: string;
  workspaceId: string;
}

export type EditRetryIntent =
  | EditRetryAvailabilityReceivedIntent
  | EditRetryRecoveryRequestedIntent
  | EditRetryRequestedIntent;

export interface TurnEditRetryCommand {
  type: "turn/editRetry";
  agentSessionId: string;
  clientOperationId: string;
  commandId: string;
  editedText: string;
  expectedHistoryRevision: number;
  timeoutMs?: number;
  turnId: string;
  workspaceId: string;
}

export interface TurnRecoverEditRetryCommand {
  type: "turn/recoverEditRetry";
  action: AgentActivityEditRetryRecoveryAction;
  agentSessionId: string;
  commandId: string;
  operationId: string;
  timeoutMs?: number;
  workspaceId: string;
}

export type EditRetryCommand =
  | TurnEditRetryCommand
  | TurnRecoverEditRetryCommand;
