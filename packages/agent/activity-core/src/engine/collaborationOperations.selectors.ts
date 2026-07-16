import type { CollaborationOperationRecord } from "./collaborationOperations.types.ts";
import type { AgentSessionEngineState } from "./types.ts";

export function selectCollaborationOperation(
  state: AgentSessionEngineState,
  requestId: string
): CollaborationOperationRecord | null {
  return state.collaborationOperations.byRequestId[requestId.trim()] ?? null;
}
