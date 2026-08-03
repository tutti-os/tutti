export type AgentActivityEditRetryRecoveryState =
  | "prepared"
  | "rolling_back"
  | "resend_pending"
  | "recovery_required"
  | "completed";

export type AgentActivityEditRetryRecoveryAction =
  | "reconcile"
  | "retry_replacement"
  | "abandon";

export type AgentActivityEditRetryReasonCode =
  | "retry_wait"
  | "retry_budget_exhausted"
  | "local_state_inconsistent"
  | "rollout_disabled"
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
  impactScope?: "session";
  supported: boolean;
  eligible: boolean;
  turnId?: string;
  historyRevision: number;
  recoveryState: AgentActivityEditRetryRecoveryState;
  operationId?: string;
  operationVersion?: number;
  automatic?: boolean;
  nextAttemptAtUnixMs?: number;
  attempt?: number;
  availableActions: readonly AgentActivityEditRetryRecoveryAction[];
  reasonCode?: AgentActivityEditRetryReasonCode;
}

export interface AgentActivityEditRetryResult {
  impactScope?: "session";
  operationId: string;
  operationVersion?: number;
  state: AgentActivityEditRetryRecoveryState;
  retractedTurnId: string;
  replacementTurnId?: string;
  historyRevision: number;
  automatic?: boolean;
  nextAttemptAtUnixMs?: number;
  attempt?: number;
  availableActions?: readonly AgentActivityEditRetryRecoveryAction[];
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
  clientActionId: string;
  expectedHistoryRevision: number;
  expectedOperationVersion: number;
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
  errorReason: string | null;
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
  clientActionId: string;
  commandId: string;
  expectedHistoryRevision: number;
  expectedOperationVersion: number;
  operationId: string;
  timeoutMs?: number;
  workspaceId: string;
}

export type EditRetryCommand =
  | TurnEditRetryCommand
  | TurnRecoverEditRetryCommand;
