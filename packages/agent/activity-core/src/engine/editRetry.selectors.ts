import type { AgentSessionEngineState } from "./types.ts";
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
  errorMessage: null,
  requestKey: null,
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

export function editRetryPresentationRecordsEqual(
  left: EditRetryPresentationRecord,
  right: EditRetryPresentationRecord
): boolean {
  return (
    left.availability === right.availability &&
    left.operation === right.operation
  );
}
