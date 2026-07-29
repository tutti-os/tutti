import type { AgentActivityForkSessionResult } from "../sessionFork.types.ts";
import type { AgentActivitySession } from "../types.ts";
import type {
  SessionDeleteMutationResult,
  SessionMutationRecord
} from "./sessionMutations.types.ts";

export function validPinResult(
  value: unknown,
  record: Extract<SessionMutationRecord, { kind: "pin" }>
): AgentActivitySession | null {
  if (!value || typeof value !== "object") return null;
  const session = (value as { session?: Partial<AgentActivitySession> })
    .session;
  return session?.agentSessionId?.trim() === record.agentSessionIds[0] &&
    session.workspaceId?.trim() === record.workspaceId &&
    Array.isArray(session.latestTurnInteractions) &&
    Array.isArray(session.pendingInteractions)
    ? (session as AgentActivitySession)
    : null;
}

export function validDeleteResult(
  value: unknown
): SessionDeleteMutationResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<SessionDeleteMutationResult>;
  if (
    typeof result.removedMessages !== "number" ||
    typeof result.removedSessions !== "number" ||
    !Array.isArray(result.cleanupFailedSessionIds) ||
    !result.cleanupFailedSessionIds.every((id) => typeof id === "string") ||
    !Array.isArray(result.removedSessionIds) ||
    !result.removedSessionIds.every((id) => typeof id === "string")
  ) {
    return null;
  }
  return {
    cleanupFailedSessionIds: result.cleanupFailedSessionIds.map((id) =>
      id.trim()
    ),
    removedMessages: result.removedMessages,
    removedSessionIds: result.removedSessionIds.map((id) => id.trim()),
    removedSessions: result.removedSessions
  };
}

export function validForkResult(
  value: unknown,
  record: Extract<SessionMutationRecord, { kind: "forkThroughTurn" }>
): AgentActivityForkSessionResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<AgentActivityForkSessionResult>;
  const operationId = result.operationId?.trim() ?? "";
  const requestId = result.requestId?.trim() ?? "";
  const sourceAgentSessionId = result.sourceAgentSessionId?.trim() ?? "";
  const targetAgentSessionId = result.targetAgentSessionId?.trim() ?? "";
  const turnId = result.turnId?.trim() ?? "";
  const status = result.status;
  if (
    !operationId ||
    !requestId ||
    !targetAgentSessionId ||
    targetAgentSessionId === sourceAgentSessionId ||
    sourceAgentSessionId !== record.agentSessionIds[0] ||
    turnId !== record.turnId ||
    (status !== "accepted" &&
      status !== "committed" &&
      status !== "failed" &&
      status !== "unknown")
  ) {
    return null;
  }
  const exactAttemptIdentity =
    requestId === record.requestId &&
    targetAgentSessionId === record.targetAgentSessionId;
  if (status !== "committed" && !exactAttemptIdentity) {
    return null;
  }
  const session = result.session;
  if (status === "committed") {
    const lineage = session?.forkedFrom;
    if (
      session?.agentSessionId?.trim() !== targetAgentSessionId ||
      session.workspaceId?.trim() !== record.workspaceId ||
      lineage?.operationId?.trim() !== operationId ||
      lineage.sourceAgentSessionId?.trim() !== sourceAgentSessionId ||
      lineage.sourceTurnId?.trim() !== turnId ||
      !lineage.targetTurnId?.trim() ||
      !Array.isArray(session.latestTurnInteractions) ||
      !Array.isArray(session.pendingInteractions)
    ) {
      return null;
    }
  } else if (session !== null) {
    return null;
  }
  return result as AgentActivityForkSessionResult;
}
