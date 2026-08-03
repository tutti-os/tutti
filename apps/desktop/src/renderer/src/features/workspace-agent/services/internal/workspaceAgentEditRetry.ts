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
    impactScope: availability.impactScope ?? "session",
    supported: availability.supported,
    eligible: availability.eligible,
    ...(availability.turnId ? { turnId: availability.turnId } : {}),
    historyRevision: availability.historyRevision,
    recoveryState: availability.recoveryState,
    ...(availability.operationId
      ? { operationId: availability.operationId }
      : {}),
    ...(availability.operationVersion !== undefined
      ? { operationVersion: availability.operationVersion }
      : {}),
    ...(availability.automatic !== undefined
      ? { automatic: availability.automatic }
      : {}),
    ...(retryNextAttemptAtUnixMs(availability) !== undefined
      ? { nextAttemptAtUnixMs: retryNextAttemptAtUnixMs(availability) }
      : {}),
    ...(availability.attempt !== undefined
      ? { attempt: availability.attempt }
      : {}),
    availableActions: [...availability.availableActions],
    ...(availability.reasonCode ? { reasonCode: availability.reasonCode } : {})
  };
}

export function editRetryResultFromTuttid(
  result: WorkspaceAgentEditRetryResponse
): AgentActivityEditRetryResult {
  return {
    impactScope: result.impactScope ?? "session",
    operationId: result.operationId,
    ...(result.operationVersion !== undefined
      ? { operationVersion: result.operationVersion }
      : {}),
    state: result.state,
    retractedTurnId: result.retractedTurnId,
    ...(result.replacementTurnId
      ? { replacementTurnId: result.replacementTurnId }
      : {}),
    historyRevision: result.historyRevision,
    ...(result.automatic !== undefined ? { automatic: result.automatic } : {}),
    ...(retryNextAttemptAtUnixMs(result) !== undefined
      ? { nextAttemptAtUnixMs: retryNextAttemptAtUnixMs(result) }
      : {}),
    ...(result.attempt !== undefined ? { attempt: result.attempt } : {}),
    ...(result.availableActions
      ? { availableActions: [...result.availableActions] }
      : {}),
    ...(result.reasonCode ? { reasonCode: result.reasonCode } : {})
  };
}

function retryNextAttemptAtUnixMs(input: {
  nextAttemptAt?: number;
  nextAttemptAtUnixMs?: number;
}): number | undefined {
  return input.nextAttemptAtUnixMs ?? input.nextAttemptAt;
}
