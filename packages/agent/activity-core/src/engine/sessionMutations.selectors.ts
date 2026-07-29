import type { AgentSessionEngineState } from "./types.ts";
import type { SessionForkThroughTurnMutationRecord } from "./sessionMutations.types.ts";

export interface SessionForkThroughTurnMutationSelectorInput {
  sourceAgentSessionId: string;
  turnId: string;
  workspaceId: string;
}

export interface SessionForkThroughTurnPendingSelectorInput {
  sourceAgentSessionId: string | null | undefined;
  workspaceId: string;
}

export function selectSessionMutation(
  state: AgentSessionEngineState,
  mutationId: string
) {
  return state.sessionMutations.byMutationId[mutationId.trim()] ?? null;
}

export function selectSessionMutations(state: AgentSessionEngineState) {
  return Object.values(state.sessionMutations.byMutationId);
}

/**
 * Returns the newest retryable mutation for one exact through-Turn boundary.
 * Succeeded records normally do not capture a later explicit Fork of the same
 * boundary. The exception is a committed fork whose observation ACK is still
 * coordinating with the Store: it retains its durable request/target identity
 * until that barrier is acknowledged.
 */
export function selectSessionForkThroughTurnMutation(
  state: AgentSessionEngineState,
  input: SessionForkThroughTurnMutationSelectorInput
): SessionForkThroughTurnMutationRecord | null {
  const workspaceId = input.workspaceId.trim();
  const sourceAgentSessionId = input.sourceAgentSessionId.trim();
  const turnId = input.turnId.trim();
  const records = Object.values(state.sessionMutations.byMutationId);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record?.kind === "forkThroughTurn" &&
      record.workspaceId === workspaceId &&
      record.agentSessionIds[0] === sourceAgentSessionId &&
      record.turnId === turnId
    ) {
      return record.status === "succeeded" &&
        (record.ackStatus === "idle" || record.ackStatus === "acknowledged")
        ? null
        : record;
    }
  }
  return null;
}

export function selectPendingSessionForkThroughTurnIds(
  state: AgentSessionEngineState,
  input: SessionForkThroughTurnPendingSelectorInput
): string[] {
  const workspaceId = input.workspaceId.trim();
  const sourceAgentSessionId = input.sourceAgentSessionId?.trim() ?? "";
  if (!workspaceId || !sourceAgentSessionId) {
    return [];
  }
  return Object.values(state.sessionMutations.byMutationId).flatMap((record) =>
    record.kind === "forkThroughTurn" &&
    record.status === "inFlight" &&
    record.workspaceId === workspaceId &&
    record.agentSessionIds[0] === sourceAgentSessionId
      ? [record.turnId]
      : []
  );
}
