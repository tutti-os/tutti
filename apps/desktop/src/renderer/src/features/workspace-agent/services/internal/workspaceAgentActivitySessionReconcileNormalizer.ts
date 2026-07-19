import type {
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivityTurn,
  SessionDeletionEvidence,
  SessionReconcileResult
} from "@tutti-os/agent-activity-core";
import { isWorkspaceAgentSessionNotFoundError } from "./workspaceAgentActivityDiagnostics.ts";
import type { AgentActivitySessionDetail } from "./workspaceAgentActivityReconcileTypes.ts";

/**
 * Transport/DTO normalization for session reconcile command results.
 * Policy (tombstone, pending-create settle, availability) stays in activity-core.
 */
export function sessionReconcileResultFromFound(input: {
  detail: AgentActivitySessionDetail;
  live?: boolean;
  messages?: readonly AgentActivityMessage[];
}): SessionReconcileResult {
  return {
    kind: "found",
    session: input.detail.session,
    childSessions: input.detail.childSessions,
    turns: input.detail.turns,
    ...(input.messages && input.messages.length > 0
      ? { messages: input.messages }
      : {}),
    ...(input.live === true ? { live: true } : {})
  };
}

export function sessionReconcileResultFromTransportError(
  error: unknown
): SessionReconcileResult | null {
  if (isWorkspaceAgentSessionNotFoundError(error)) {
    // Bare HTTP 404 is transport absence only — never deletion evidence.
    return { kind: "absent" };
  }
  return null;
}

export function sessionDeletionEvidenceFromEvent(
  data: unknown
): SessionDeletionEvidence {
  const deletedAtUnixMs =
    data &&
    typeof data === "object" &&
    typeof (data as { deletedAtUnixMs?: unknown }).deletedAtUnixMs === "number"
      ? (data as { deletedAtUnixMs: number }).deletedAtUnixMs
      : undefined;
  return {
    source: "session_deleted_event",
    ...(deletedAtUnixMs === undefined ? {} : { deletedAtUnixMs })
  };
}

export function sessionReconcileFoundParts(input: {
  session: AgentActivitySession;
  childSessions?: readonly AgentActivitySession[];
  turns?: readonly AgentActivityTurn[];
  messages?: readonly AgentActivityMessage[];
  live?: boolean;
}): Extract<SessionReconcileResult, { kind: "found" }> {
  return {
    kind: "found",
    session: input.session,
    ...(input.childSessions ? { childSessions: input.childSessions } : {}),
    ...(input.turns ? { turns: input.turns } : {}),
    ...(input.messages && input.messages.length > 0
      ? { messages: input.messages }
      : {}),
    ...(input.live === true ? { live: true } : {})
  };
}
