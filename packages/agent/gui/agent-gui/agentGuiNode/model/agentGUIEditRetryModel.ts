import type {
  AgentActivityEditRetryAvailability,
  AgentActivityEditRetryRecoveryAction,
  AgentActivityEditRetryResult,
  EditRetryOperationStatus,
} from "@tutti-os/agent-activity-core";

export type AgentGUIEditRetryPresentationState =
  | "ready"
  | "recovering"
  | "retry_wait"
  | "action_required"
  | "terminal";

// This is transient UI feedback only. Canonical availability and recovery
// actions remain owned by activity-core/Host and are never inferred here.
export type AgentGUIEditRetryActionFeedback =
  | "refreshing"
  | "request_failed"
  | null;

export interface AgentGUIEditRetryPresentation {
  state: AgentGUIEditRetryPresentationState;
  editableTurnId: string | null;
  operationId: string | null;
  operationVersion: number | null;
  automatic: boolean;
  nextAttemptAtUnixMs: number | null;
  attempt: number | null;
  availableActions: readonly AgentActivityEditRetryRecoveryAction[];
  reasonCode: AgentActivityEditRetryAvailability["reasonCode"] | null;
  actionFeedback: AgentGUIEditRetryActionFeedback;
  actionPending: boolean;
}

export function projectAgentGUIEditRetryPresentation(input: {
  availability: AgentActivityEditRetryAvailability | null;
  commandStatus: EditRetryOperationStatus;
  commandResult?: AgentActivityEditRetryResult | null;
  actionFeedback?: AgentGUIEditRetryActionFeedback;
}): AgentGUIEditRetryPresentation {
  const availability = input.availability;
  const recovering =
    input.commandStatus === "pending" ||
    input.commandStatus === "reconciling" ||
    availability?.recoveryState === "rolling_back";
  const retryWait =
    !recovering &&
    availability?.automatic === true &&
    Boolean(availability.operationId) &&
    typeof availability.nextAttemptAtUnixMs === "number" &&
    availability.nextAttemptAtUnixMs > 0;
  const actionRequired =
    !recovering &&
    !retryWait &&
    (availability?.recoveryState === "resend_pending" ||
      availability?.recoveryState === "recovery_required" ||
      availability?.reasonCode === "rollout_disabled" ||
      availability?.reasonCode === "provider_unsupported" ||
      availability?.reasonCode === "retry_budget_exhausted" ||
      availability?.reasonCode === "local_state_inconsistent" ||
      (input.commandStatus === "failed" && availability?.eligible !== true));
  const terminal =
    !recovering &&
    !retryWait &&
    !actionRequired &&
    (availability?.recoveryState === "completed" ||
      input.commandResult?.state === "completed");
  return {
    state: recovering
      ? "recovering"
      : retryWait
        ? "retry_wait"
        : actionRequired
          ? "action_required"
          : terminal
            ? "terminal"
            : "ready",
    editableTurnId:
      !recovering &&
      !retryWait &&
      !actionRequired &&
      !terminal &&
      availability?.supported === true &&
      availability.eligible === true
        ? (availability.turnId ?? null)
        : null,
    operationId: availability?.operationId ?? null,
    operationVersion: availability?.operationVersion ?? null,
    automatic: availability?.automatic === true,
    nextAttemptAtUnixMs:
      typeof availability?.nextAttemptAtUnixMs === "number" &&
      availability.nextAttemptAtUnixMs > 0
        ? availability.nextAttemptAtUnixMs
        : null,
    attempt: availability?.attempt ?? null,
    availableActions: availability?.availableActions ?? [],
    actionFeedback: input.actionFeedback ?? null,
    actionPending:
      input.commandStatus === "pending" ||
      input.commandStatus === "reconciling",
    reasonCode:
      availability?.reasonCode ?? input.commandResult?.reasonCode ?? null,
  };
}
