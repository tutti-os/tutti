import type {
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivityTurn
} from "../types.ts";
import { isSessionDeletionEvidence } from "./sessionDeletion.types.ts";
import type {
  SessionReconcileRecord,
  SessionReconcileResult
} from "./sessionReconcile.types.ts";

export type SessionReconcileResultValidation =
  | { kind: "valid"; result: SessionReconcileResult }
  | { kind: "invalid"; reason: string };

export function validateSessionReconcileResult(
  value: unknown,
  record: SessionReconcileRecord | undefined
): SessionReconcileResultValidation {
  if (!record) {
    return { kind: "invalid", reason: "reconcile_record_missing" };
  }
  if (!value || typeof value !== "object") {
    return { kind: "invalid", reason: "reconcile_result_missing" };
  }
  const candidate = value as {
    kind?: unknown;
    session?: Partial<AgentActivitySession>;
    childSessions?: unknown;
    turns?: unknown;
    messages?: unknown;
    live?: unknown;
    evidence?: unknown;
  };
  if (candidate.kind === "absent") {
    return { kind: "valid", result: { kind: "absent" } };
  }
  if (candidate.kind === "deleted") {
    if (!isSessionDeletionEvidence(candidate.evidence)) {
      return { kind: "invalid", reason: "reconcile_deleted_evidence_missing" };
    }
    return {
      kind: "valid",
      result: { kind: "deleted", evidence: candidate.evidence }
    };
  }
  if (candidate.kind !== "found") {
    return { kind: "invalid", reason: "reconcile_result_kind_unknown" };
  }
  const session = candidate.session;
  if (
    !session ||
    typeof session.agentSessionId !== "string" ||
    typeof session.workspaceId !== "string" ||
    session.agentSessionId.trim() !== record.agentSessionId ||
    session.workspaceId.trim() !== record.workspaceId
  ) {
    return { kind: "invalid", reason: "reconcile_found_session_mismatch" };
  }
  if (
    candidate.childSessions !== undefined &&
    !Array.isArray(candidate.childSessions)
  ) {
    return { kind: "invalid", reason: "reconcile_found_children_malformed" };
  }
  if (candidate.turns !== undefined && !Array.isArray(candidate.turns)) {
    return { kind: "invalid", reason: "reconcile_found_turns_malformed" };
  }
  if (candidate.messages !== undefined && !Array.isArray(candidate.messages)) {
    return { kind: "invalid", reason: "reconcile_found_messages_malformed" };
  }
  const result: Extract<SessionReconcileResult, { kind: "found" }> = {
    kind: "found",
    session: session as AgentActivitySession
  };
  if (candidate.childSessions) {
    result.childSessions = candidate.childSessions as AgentActivitySession[];
  }
  if (candidate.turns) {
    result.turns = candidate.turns as AgentActivityTurn[];
  }
  if (candidate.messages) {
    result.messages = candidate.messages as AgentActivityMessage[];
  }
  if (candidate.live === true) {
    result.live = true;
  }
  return { kind: "valid", result };
}
