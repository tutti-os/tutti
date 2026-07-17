import type { AgentActivitySendInputResult } from "../types.ts";
import type { AgentActivitySession } from "../types.ts";
import type {
  AgentActivityTurn,
  AgentActivityTurnCancelResponse
} from "../types.ts";
import type { PendingSubmitIntentRecord } from "./pendingIntents.types.ts";

export type SendInputResultValidation =
  | { kind: "valid"; result: AgentActivitySendInputResult }
  | { kind: "invalid"; reason: string };

export type ScopedSessionResultValidation =
  | { kind: "valid"; session: AgentActivitySession }
  | { kind: "invalid"; reason: string };

export type CancelResultValidation =
  | { kind: "valid"; response: AgentActivityTurnCancelResponse }
  | { kind: "invalid"; reason: string };

export function validateCancelResult(
  value: unknown,
  expected:
    | {
        agentSessionId: string;
        currentTurn: AgentActivityTurn | null;
        turnId: string | null;
        workspaceMatches: boolean;
      }
    | undefined
): CancelResultValidation {
  if (!expected || !expected.turnId || !expected.workspaceMatches) {
    return { kind: "invalid", reason: "cancel_scope_missing" };
  }
  if (!value || typeof value !== "object") {
    return { kind: "invalid", reason: "cancel_result_missing" };
  }
  const response = value as Partial<AgentActivityTurnCancelResponse>;
  const cancel = response.cancel;
  if (!cancel || typeof cancel.canceled !== "boolean") {
    return { kind: "invalid", reason: "cancel_result_malformed" };
  }
  const turn = response.turn;
  const exactTurn =
    turn?.agentSessionId === expected.agentSessionId &&
    turn.turnId === expected.turnId;
  const cancelRequested =
    cancel.canceled === false &&
    cancel.reason === "cancel_requested" &&
    exactTurn &&
    turn.phase === "settling" &&
    turn.outcome == null;
  const canceled =
    cancel.canceled === true &&
    cancel.reason === "turn_canceled" &&
    exactTurn &&
    turn.phase === "settled" &&
    turn.outcome === "canceled";
  const alreadySettled =
    cancel.canceled === false &&
    cancel.reason === "already_settled" &&
    ((exactTurn && turn.phase === "settled" && turn.outcome !== null) ||
      expected.currentTurn?.phase === "settled");
  const targetAbsent =
    cancel.canceled === false &&
    cancel.reason === "not_found" &&
    expected.currentTurn === null;
  return cancelRequested || canceled || alreadySettled || targetAbsent
    ? { kind: "valid", response: response as AgentActivityTurnCancelResponse }
    : { kind: "invalid", reason: "cancel_target_mismatch" };
}

export function validateScopedSessionResult(
  value: unknown,
  expected: { agentSessionId: string; workspaceId: string } | undefined,
  requireTopLevelSessionId = false
): ScopedSessionResultValidation {
  if (!expected || !value || typeof value !== "object") {
    return { kind: "invalid", reason: "scoped_session_result_missing" };
  }
  const result = value as {
    agentSessionId?: unknown;
    session?: Partial<AgentActivitySession>;
  };
  const session = result.session;
  if (
    !session ||
    typeof session.agentSessionId !== "string" ||
    typeof session.workspaceId !== "string" ||
    session.agentSessionId.trim() !== expected.agentSessionId ||
    session.workspaceId.trim() !== expected.workspaceId ||
    (requireTopLevelSessionId &&
      (typeof result.agentSessionId !== "string" ||
        result.agentSessionId.trim() !== expected.agentSessionId))
  ) {
    return { kind: "invalid", reason: "scoped_session_result_mismatch" };
  }
  return { kind: "valid", session: session as AgentActivitySession };
}

export function validateSendInputResult(
  value: unknown,
  record: PendingSubmitIntentRecord | undefined
): SendInputResultValidation {
  if (!record) {
    return { kind: "invalid", reason: "submit_request_missing" };
  }
  if (!isSendInputResult(value)) {
    return {
      kind: "invalid",
      reason: "send_result_entities_missing"
    };
  }
  const sessionId = value.session.agentSessionId.trim();
  const workspaceId = value.session.workspaceId.trim();
  if (sessionId !== record.agentSessionId) {
    return {
      kind: "invalid",
      reason: "send_result_session_scope_mismatch"
    };
  }
  if (workspaceId !== record.workspaceId) {
    return {
      kind: "invalid",
      reason: "send_result_workspace_scope_mismatch"
    };
  }
  if (value.kind === "goalControl") {
    return { kind: "valid", result: value };
  }
  const turnSessionId = value.turn.agentSessionId.trim();
  const turnId = value.turnId.trim();
  if (!turnId || value.turn.turnId.trim() !== turnId) {
    return { kind: "invalid", reason: "send_result_turn_scope_mismatch" };
  }
  if (turnSessionId !== record.agentSessionId) {
    return {
      kind: "invalid",
      reason: "send_result_session_scope_mismatch"
    };
  }
  return { kind: "valid", result: value };
}

function isSendInputResult(
  value: unknown
): value is AgentActivitySendInputResult {
  if (!value || typeof value !== "object") return false;
  const result = value as {
    kind?: unknown;
    session?: Partial<AgentActivitySession>;
    turn?: Partial<AgentActivityTurn>;
    turnId?: unknown;
  };
  if (
    result.kind === "goalControl" &&
    result.session &&
    typeof result.session.agentSessionId === "string" &&
    typeof result.session.workspaceId === "string" &&
    Array.isArray(result.session.latestTurnInteractions) &&
    Array.isArray(result.session.pendingInteractions)
  ) {
    return true;
  }
  return Boolean(
    result.session &&
    result.turn &&
    typeof result.turnId === "string" &&
    typeof result.session.agentSessionId === "string" &&
    typeof result.session.workspaceId === "string" &&
    typeof result.turn.agentSessionId === "string" &&
    typeof result.turn.turnId === "string"
  );
}
