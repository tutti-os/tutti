import type {
  WorkspaceAgentEditRetryAvailability,
  WorkspaceAgentEditRetryResponse
} from "@tutti-os/client-tuttid-ts";
import type {
  AgentActivityEditRetryAvailability,
  AgentActivityEditRetryResult
} from "@tutti-os/agent-activity-core";

export function editRetryAvailabilityFromTuttid(
  availability: WorkspaceAgentEditRetryAvailability
): AgentActivityEditRetryAvailability {
  return {
    supported: availability.supported,
    eligible: availability.eligible,
    ...(availability.turnId ? { turnId: availability.turnId } : {}),
    historyRevision: availability.historyRevision,
    recoveryState: availability.recoveryState,
    ...(availability.operationId
      ? { operationId: availability.operationId }
      : {}),
    availableActions: [...availability.availableActions],
    ...(availability.reasonCode ? { reasonCode: availability.reasonCode } : {})
  };
}

export function editRetryResultFromTuttid(
  result: WorkspaceAgentEditRetryResponse
): AgentActivityEditRetryResult {
  return {
    operationId: result.operationId,
    state: result.state,
    retractedTurnId: result.retractedTurnId,
    ...(result.replacementTurnId
      ? { replacementTurnId: result.replacementTurnId }
      : {}),
    historyRevision: result.historyRevision,
    ...(result.reasonCode ? { reasonCode: result.reasonCode } : {})
  };
}
