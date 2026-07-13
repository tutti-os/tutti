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

export interface WorkspaceAgentCanonicalStatusInput {
  status?: string | null;
  activeTurnPhase?: string | null;
  latestTurnOutcome?: string | null;
}

const FAILED = new Set(["failed", "error"]);
const CANCELED = new Set(["canceled", "cancelled", "interrupted"]);
const COMPLETED = new Set(["completed", "ended", "end"]);
const WORKING = new Set([
  "submitted",
  "working",
  "running",
  "streaming",
  "settling"
]);
const READY = new Set(["ready", "idle", "active"]);

export function normalizeWorkspaceAgentStatus(
  input: WorkspaceAgentCanonicalStatusInput
): NormalizedWorkspaceAgentStatus {
  return normalizeOptionalWorkspaceAgentStatus(input) ?? { kind: "ready" };
}

export function normalizeOptionalWorkspaceAgentStatus(
  input: WorkspaceAgentCanonicalStatusInput
): NormalizedWorkspaceAgentStatus | null {
  const status = token(input.status);
  const phase = token(input.activeTurnPhase);
  const outcome = token(input.latestTurnOutcome);
  if (!status && !phase && !outcome) return null;
  const waitKind = waitingKind(phase || status);
  if (waitKind) return { kind: "waiting", waitKind };
  if (phase === "waiting" || status === "waiting") return { kind: "waiting" };
  if (WORKING.has(phase)) return { kind: "working" };
  if (FAILED.has(outcome)) return { kind: "failed" };
  if (CANCELED.has(outcome)) return { kind: "canceled" };
  if (COMPLETED.has(outcome)) return { kind: "completed" };
  if (FAILED.has(status)) return { kind: "failed" };
  if (CANCELED.has(status)) return { kind: "canceled" };
  if (COMPLETED.has(status)) return { kind: "completed" };
  if (WORKING.has(status)) return { kind: "working" };
  if (READY.has(status)) return { kind: "ready" };
  return null;
}

export function isNormalizedWorkspaceAgentRunningStatus(
  input: WorkspaceAgentCanonicalStatusInput
): boolean {
  return normalizeWorkspaceAgentStatus(input).kind === "working";
}

function waitingKind(value: string): "approval" | "input" | undefined {
  if (value === "waiting_approval" || value === "awaiting_approval") {
    return "approval";
  }
  return value === "waiting_input" ? "input" : undefined;
}

function token(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
