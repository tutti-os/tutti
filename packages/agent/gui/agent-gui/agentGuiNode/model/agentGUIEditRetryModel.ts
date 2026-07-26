import type {
  AgentActivityEditRetryAvailability,
  AgentActivityEditRetryRecoveryAction,
  EditRetryOperationStatus
} from "@tutti-os/agent-activity-core";

export type AgentGUIEditRetryPresentationState =
  | "ready"
  | "processing"
  | "needs_action";

export interface AgentGUIEditRetryPresentation {
  state: AgentGUIEditRetryPresentationState;
  editableTurnId: string | null;
  operationId: string | null;
  availableActions: readonly AgentActivityEditRetryRecoveryAction[];
  reasonCode: AgentActivityEditRetryAvailability["reasonCode"] | null;
}

export function projectAgentGUIEditRetryPresentation(input: {
  availability: AgentActivityEditRetryAvailability | null;
  commandStatus: EditRetryOperationStatus;
}): AgentGUIEditRetryPresentation {
  const availability = input.availability;
  const processing =
    input.commandStatus === "pending" ||
    input.commandStatus === "reconciling" ||
    availability?.recoveryState === "rolling_back";
  const needsAction =
    !processing &&
    (availability?.recoveryState === "resend_pending" ||
      availability?.recoveryState === "recovery_required" ||
      (input.commandStatus === "failed" && availability?.eligible !== true));
  return {
    state: processing ? "processing" : needsAction ? "needs_action" : "ready",
    editableTurnId:
      !processing &&
      !needsAction &&
      availability?.supported === true &&
      availability.eligible === true
        ? (availability.turnId ?? null)
        : null,
    operationId: availability?.operationId ?? null,
    availableActions: availability?.availableActions ?? [],
    reasonCode: availability?.reasonCode ?? null
  };
}
