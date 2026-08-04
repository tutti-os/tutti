import type { AgentSessionEngineStateBase } from "./types.ts";
import type {
  AgentActivityEditRetryAvailability,
  EditRetryOperationRecord
} from "./editRetry.types.ts";

export interface EditRetryPresentationRecord {
  availability: AgentActivityEditRetryAvailability | null;
  operation: EditRetryOperationRecord;
}

const IDLE_OPERATION: EditRetryOperationRecord = {
  clientOperationId: null,
  commandId: null,
  errorCode: null,
  errorReason: null,
  errorMessage: null,
  requestKey: null,
  result: null,
  status: "idle",
  workspaceId: null
};

export function selectEditRetryPresentation(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined
): EditRetryPresentationRecord {
  const normalized = agentSessionId?.trim() ?? "";
  return {
    availability: state.editRetry.availabilityBySessionId[normalized] ?? null,
    operation:
      state.editRetry.operationBySessionId[normalized] ?? IDLE_OPERATION
  };
}

export function selectEditRetryAvailabilityIsNewer(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined,
  incoming: AgentActivityEditRetryAvailability
): boolean {
  const current = selectEditRetryPresentation(
    state,
    agentSessionId
  ).availability;
  return current ? isEditRetryAvailabilityOlder(incoming, current) : false;
}

/** Returns true when an availability snapshot is older than the current one. */
export function isEditRetryAvailabilityOlder(
  incoming: AgentActivityEditRetryAvailability,
  current: AgentActivityEditRetryAvailability
): boolean {
  if (incoming.historyRevision !== current.historyRevision) {
    return incoming.historyRevision < current.historyRevision;
  }
  // A different operation id at the same history revision is a new lineage;
  // let the authoritative snapshot win rather than guessing between them.
  if (
    incoming.operationId &&
    current.operationId &&
    incoming.operationId !== current.operationId
  ) {
    return false;
  }
  const operationVersion = compareOptionalNumber(
    incoming.operationVersion,
    current.operationVersion
  );
  if (operationVersion !== 0) return operationVersion < 0;
  const attempt = compareOptionalNumber(incoming.attempt, current.attempt);
  if (attempt !== 0) return attempt < 0;
  const retryAt = compareOptionalNumber(
    incoming.nextAttemptAtUnixMs,
    current.nextAttemptAtUnixMs
  );
  if (retryAt !== 0) return retryAt < 0;
  return (
    editRetryRecoveryRank(incoming.recoveryState) <
    editRetryRecoveryRank(current.recoveryState)
  );
}

export function editRetryPresentationRecordsEqual(
  left: EditRetryPresentationRecord,
  right: EditRetryPresentationRecord
): boolean {
  return (
    left.availability === right.availability &&
    left.operation === right.operation
  );
}

function editRetryRecoveryRank(
  state: AgentActivityEditRetryAvailability["recoveryState"]
): number {
  switch (state) {
    case "prepared":
    case "completed":
      return 0;
    case "rolling_back":
      return 1;
    case "resend_pending":
      return 2;
    case "recovery_required":
      return 3;
  }
}

function compareOptionalNumber(
  incoming: number | undefined,
  current: number | undefined
): number {
  return (incoming ?? 0) - (current ?? 0);
}
