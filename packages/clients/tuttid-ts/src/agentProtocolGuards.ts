/**
 * Protocol v2 completeness guards (agent-gui refactor plan, rule six).
 *
 * This is the TypeScript half of the projection completeness protection:
 * the Go side pairs every domain-to-generated projection with a reflective
 * field-coverage test (see services/tuttid/service/agent/
 * activity_projection_turns_test.go); this module expresses the same
 * constraint with `satisfies`. When `pnpm generate:api` grows a generated
 * enum member or a `WorkspaceAgentTurn`/`WorkspaceAgentInteraction` field,
 * typecheck fails here until the hand-written layer acknowledges it.
 */
import type {
  WorkspaceAgentInteraction,
  WorkspaceAgentInteractionKind,
  WorkspaceAgentInteractionStatus,
  WorkspaceAgentTurn,
  WorkspaceAgentTurnOutcome,
  WorkspaceAgentTurnPhase
} from "./generated/index.ts";

/** Every closed turn phase, usable for iteration and exhaustive UI mapping. */
export const WORKSPACE_AGENT_TURN_PHASES = [
  "submitted",
  "running",
  "waiting",
  "settling",
  "settled"
] as const satisfies readonly WorkspaceAgentTurnPhase[];

/** Every closed turn outcome; outcome only exists once a turn is settled. */
export const WORKSPACE_AGENT_TURN_OUTCOMES = [
  "completed",
  "failed",
  "canceled",
  "interrupted"
] as const satisfies readonly WorkspaceAgentTurnOutcome[];

/** Every closed interaction kind. */
export const WORKSPACE_AGENT_INTERACTION_KINDS = [
  "approval",
  "question",
  "plan"
] as const satisfies readonly WorkspaceAgentInteractionKind[];

/** Every closed interaction status. */
export const WORKSPACE_AGENT_INTERACTION_STATUSES = [
  "pending",
  "answered",
  "superseded"
] as const satisfies readonly WorkspaceAgentInteractionStatus[];

// The exemplars below are type-level guards, not runtime values: `Required<>`
// forces optional generated fields into the literal, so a newly generated
// field breaks typecheck here even when it is optional on the wire.

const workspaceAgentTurnCompletenessExemplar = {
  turnId: "turn-1",
  agentSessionId: "session-1",
  phase: "settled",
  outcome: "completed",
  error: { message: "" },
  fileChanges: null,
  completedCommand: { kind: "review", status: "completed" },
  capabilityRefs: [],
  startedAtUnixMs: 0,
  settledAtUnixMs: null,
  updatedAtUnixMs: 0
} as const satisfies Required<WorkspaceAgentTurn>;
void workspaceAgentTurnCompletenessExemplar;

const workspaceAgentInteractionCompletenessExemplar = {
  requestId: "request-1",
  agentSessionId: "session-1",
  turnId: "turn-1",
  kind: "approval",
  status: "pending",
  toolName: null,
  input: null,
  output: null,
  metadata: null,
  createdAtUnixMs: 0,
  updatedAtUnixMs: 0
} as const satisfies Required<WorkspaceAgentInteraction>;
void workspaceAgentInteractionCompletenessExemplar;
