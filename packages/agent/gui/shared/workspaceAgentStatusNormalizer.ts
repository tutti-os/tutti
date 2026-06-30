export type NormalizedWorkspaceAgentStatusKind =
  | "ready"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled";

export interface NormalizedWorkspaceAgentStatus {
  kind: NormalizedWorkspaceAgentStatusKind;
  waitKind?: "approval" | "input";
}

export interface RawWorkspaceAgentStatusLike {
  lifecycleStatus?: string | null;
  effectiveStatus?: string | null;
  status?: string | null;
  turnPhase?: string | null;
  turnLifecycle?: {
    phase?: string | null;
    outcome?: string | null;
  } | null;
  currentPhase?: string | null;
}

const FAILED_STATUS_TOKENS = new Set(["failed", "error"]);
const CANCELED_STATUS_TOKENS = new Set([
  "canceled",
  "cancelled",
  "interrupted"
]);
const COMPLETED_STATUS_TOKENS = new Set(["completed", "ended", "end"]);
const WAITING_APPROVAL_TOKENS = new Set([
  "waiting_approval",
  "awaiting_approval"
]);
const WAITING_INPUT_TOKENS = new Set(["waiting_input"]);
const WAITING_STATUS_TOKENS = new Set(["waiting"]);
const WORKING_STATUS_TOKENS = new Set([
  "submitted",
  "working",
  "running",
  "streaming"
]);
const READY_STATUS_TOKENS = new Set(["ready", "idle"]);

export function normalizeWorkspaceAgentStatus(
  input: RawWorkspaceAgentStatusLike
): NormalizedWorkspaceAgentStatus {
  return normalizeOptionalWorkspaceAgentStatus(input) ?? { kind: "ready" };
}

export function normalizeOptionalWorkspaceAgentStatus(
  input: RawWorkspaceAgentStatusLike
): NormalizedWorkspaceAgentStatus | null {
  const lifecycleStatus = normalizeStatusToken(input.lifecycleStatus);
  const effectiveStatus = normalizeStatusToken(input.effectiveStatus);
  const sessionStatus = normalizeStatusToken(input.status);
  const turnLifecycleOutcome = normalizeStatusToken(
    input.turnLifecycle?.outcome
  );
  const turnPhase = normalizeStatusToken(
    input.turnLifecycle?.phase ?? input.turnPhase
  );
  const currentPhase = normalizeStatusToken(input.currentPhase);
  const tokens = [
    lifecycleStatus,
    effectiveStatus,
    sessionStatus,
    turnPhase,
    currentPhase
  ].filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  if (turnPhase === "settled") {
    if (FAILED_STATUS_TOKENS.has(turnLifecycleOutcome)) {
      return { kind: "failed" };
    }
    if (CANCELED_STATUS_TOKENS.has(turnLifecycleOutcome)) {
      return { kind: "canceled" };
    }
    if (COMPLETED_STATUS_TOKENS.has(turnLifecycleOutcome)) {
      return { kind: "completed" };
    }
    if (
      FAILED_STATUS_TOKENS.has(sessionStatus) ||
      FAILED_STATUS_TOKENS.has(currentPhase)
    ) {
      return { kind: "failed" };
    }
    if (
      CANCELED_STATUS_TOKENS.has(sessionStatus) ||
      CANCELED_STATUS_TOKENS.has(currentPhase)
    ) {
      return { kind: "canceled" };
    }
    return { kind: "completed" };
  }
  const waitKind = waitingKindFromTokens([currentPhase, turnPhase]);
  if (waitKind) {
    return { kind: "waiting", waitKind };
  }
  if (
    [currentPhase, turnPhase].some((token) => WAITING_STATUS_TOKENS.has(token))
  ) {
    return { kind: "waiting" };
  }
  if (
    [currentPhase, turnPhase].some((token) => WORKING_STATUS_TOKENS.has(token))
  ) {
    return { kind: "working" };
  }
  if (
    [currentPhase, turnPhase].some((token) => CANCELED_STATUS_TOKENS.has(token))
  ) {
    return { kind: "canceled" };
  }
  if (
    [currentPhase, turnPhase].some((token) =>
      COMPLETED_STATUS_TOKENS.has(token)
    )
  ) {
    return { kind: "completed" };
  }
  if (
    [lifecycleStatus, effectiveStatus, sessionStatus, currentPhase].some(
      (token) => FAILED_STATUS_TOKENS.has(token)
    )
  ) {
    return { kind: "failed" };
  }
  if (
    [lifecycleStatus, effectiveStatus, sessionStatus].some((token) =>
      CANCELED_STATUS_TOKENS.has(token)
    )
  ) {
    return { kind: "canceled" };
  }
  if (
    [lifecycleStatus, effectiveStatus, sessionStatus].some((token) =>
      COMPLETED_STATUS_TOKENS.has(token)
    )
  ) {
    return { kind: "completed" };
  }

  const fallbackWaitKind = waitingKindFromTokens([
    currentPhase,
    turnPhase,
    effectiveStatus,
    sessionStatus
  ]);
  if (fallbackWaitKind) {
    return { kind: "waiting", waitKind: fallbackWaitKind };
  }
  if (
    [currentPhase, turnPhase, effectiveStatus, sessionStatus].some((token) =>
      WAITING_STATUS_TOKENS.has(token)
    )
  ) {
    return { kind: "waiting" };
  }

  if (
    [currentPhase, turnPhase, effectiveStatus, sessionStatus].some((token) =>
      WORKING_STATUS_TOKENS.has(token)
    )
  ) {
    return { kind: "working" };
  }

  if (
    lifecycleStatus === "active" ||
    lifecycleStatus === "ready" ||
    [currentPhase, turnPhase, effectiveStatus, sessionStatus].some((token) =>
      READY_STATUS_TOKENS.has(token)
    )
  ) {
    return { kind: "ready" };
  }

  return null;
}

export function isNormalizedWorkspaceAgentRunningStatus(
  input: RawWorkspaceAgentStatusLike
): boolean {
  return normalizeWorkspaceAgentStatus(input).kind === "working";
}

function waitingKindFromTokens(
  tokens: readonly string[]
): "approval" | "input" | undefined {
  if (tokens.some((token) => WAITING_APPROVAL_TOKENS.has(token))) {
    return "approval";
  }
  if (tokens.some((token) => WAITING_INPUT_TOKENS.has(token))) {
    return "input";
  }
  return undefined;
}

function normalizeStatusToken(status: string | null | undefined): string {
  return status?.trim().toLowerCase() ?? "";
}
