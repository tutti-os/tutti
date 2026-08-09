import type {
  AgentActivityGoalControlResult,
  AgentActivitySessionGoal,
  AgentActivitySessionGoalState
} from "../types.ts";
import { decodeSessionProjection } from "./sessionProjection.validation.ts";
import type {
  SessionGoalControlOperation,
  SessionGoalControlResultValidation
} from "./sessionGoalControl.types.ts";

const SYNC_STATUSES = new Set([
  "pending",
  "applying",
  "synced",
  "diverged",
  "unknown",
  "failed"
]);

export function validateSessionGoalControlResult(
  value: unknown,
  operation: SessionGoalControlOperation | undefined
): SessionGoalControlResultValidation | null {
  if (!operation || !isRecord(value)) return null;
  const session = decodeSessionProjection(value.session, operation);
  if (!session || !optionalGoal(value.goal)) return null;
  const result = value as unknown as AgentActivityGoalControlResult;
  const goal: AgentActivitySessionGoal | null =
    Object.prototype.hasOwnProperty.call(value, "goal")
      ? (result.goal ?? null)
      : (session.goal ?? null);
  if (
    !optionalNullableString(value.operationId) ||
    !optionalGoalState(value.state)
  ) {
    return null;
  }
  const goalIsCanonical =
    result.state === null ||
    result.state === undefined ||
    result.state.syncStatus === "synced";
  return {
    goal,
    result,
    session:
      !goalIsCanonical || session.goal === goal
        ? session
        : { ...session, goal: goal ?? undefined }
  };
}

function optionalGoalState(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  const state = value as unknown as AgentActivitySessionGoalState;
  return (
    nonNegativeSafeInteger(state.revision) &&
    typeof state.tombstoned === "boolean" &&
    SYNC_STATUSES.has(state.syncStatus) &&
    optionalGoal(state.desired) &&
    optionalGoal(state.observed) &&
    optionalNullableString(state.pendingOperationId) &&
    isRecord(state.lastEvidence) &&
    (state.lastError === undefined || typeof state.lastError === "string") &&
    (state.observedAtUnixMs === undefined ||
      state.observedAtUnixMs === null ||
      nonNegativeSafeInteger(state.observedAtUnixMs)) &&
    nonNegativeSafeInteger(state.updatedAtUnixMs)
  );
}

function optionalGoal(value: unknown): boolean {
  return Boolean(
    value === undefined ||
    value === null ||
    (isRecord(value) &&
      typeof value.objective === "string" &&
      value.objective.trim().length > 0 &&
      [
        "active",
        "paused",
        "blocked",
        "usageLimited",
        "budgetLimited",
        "complete"
      ].includes(String(value.status)) &&
      (value.reason === undefined || typeof value.reason === "string") &&
      optionalFiniteNumber(value.startedAtUnixMs) &&
      optionalFiniteNumber(value.iterations) &&
      optionalFiniteNumber(value.durationMs) &&
      optionalFiniteNumber(value.tokens))
  );
}

function optionalFiniteNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function optionalNullableString(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length > 0)
  );
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
