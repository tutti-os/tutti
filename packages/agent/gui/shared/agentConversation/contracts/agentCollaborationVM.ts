export interface AgentCollaborationUsageVM {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Typed projection of one durable "collaboration" timeline message (the
 * daemon projects each collaboration run into the source session transcript
 * with messageId `collab:<runId>`; status transitions update the same message
 * in place). Pure data — rendering and adoption actions live in
 * `AgentCollaborationRow`.
 */
export interface AgentCollaborationVM {
  kind: "collaboration";
  runId: string;
  /** Session identity of the source transcript row, for adoption commands. */
  workspaceId: string | null;
  agentSessionId: string | null;
  mode: "consult" | "fork" | "delegate" | "handoff" | (string & {});
  status: "running" | "completed" | "failed" | "canceled" | (string & {});
  triggerSource: "user" | "agent" | "policy" | (string & {});
  triggerReason: string | null;
  targetSessionId: string | null;
  targetAgentTargetId: string | null;
  modelPlanId: string | null;
  /** Optional display name when the daemon payload carries it. */
  modelPlanName: string | null;
  model: string | null;
  contextScope: string | null;
  resultText: string | null;
  failureReason: string | null;
  durationMs: number | null;
  usage: AgentCollaborationUsageVM | null;
  adoption:
    | "pending"
    | "adopted"
    | "rejected"
    | "not_applicable"
    | (string & {});
}
