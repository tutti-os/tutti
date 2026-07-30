import type { AgentSessionEngineState } from "./types.ts";
import type {
  AgentActivityEditRetryAvailability,
  EditRetryTailPresentation,
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
  errorMessage: null,
  requestKey: null,
  result: null,
  status: "idle",
  workspaceId: null
};

export function selectEditRetryPresentation(
  state: AgentSessionEngineState,
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
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  incoming: AgentActivityEditRetryAvailability
): boolean {
  const current = selectEditRetryPresentation(
    state,
    agentSessionId
  ).availability;
  if (!current) return false;
  if (current.historyRevision !== incoming.historyRevision) {
    return current.historyRevision > incoming.historyRevision;
  }
  return (
    editRetryRecoveryRank(current.recoveryState) >
    editRetryRecoveryRank(incoming.recoveryState)
  );
}

export function selectSessionEditRetryTailPresentation(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): EditRetryTailPresentation | null {
  const normalized = agentSessionId?.trim() ?? "";
  return state.editRetry.tailBySessionId[normalized] ?? null;
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
