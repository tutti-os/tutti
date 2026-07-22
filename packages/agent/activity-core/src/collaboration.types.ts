export type AgentActivityCollaborationMode =
  | "consult"
  | "fork"
  | "delegate"
  | "handoff";

export type AgentActivityCollaborationTriggerSource =
  | "user"
  | "agent"
  | "policy";

export type AgentActivityCollaborationStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type AgentActivityCollaborationAdoption =
  | "pending"
  | "adopted"
  | "rejected"
  | "not_applicable";

export interface AgentActivityCollaborationUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * One recorded collaboration run (model consult, fork, delegate, or handoff)
 * as returned by the host collaboration-run APIs. Timeline rendering reads the
 * durable "collaboration" message projection instead; this shape is the
 * command result contract.
 */
export interface AgentActivityCollaborationRun {
  id: string;
  workspaceId: string;
  mode: AgentActivityCollaborationMode | (string & {});
  triggerSource: AgentActivityCollaborationTriggerSource | (string & {});
  triggerReason?: string | null;
  sourceSessionId?: string | null;
  targetSessionId?: string | null;
  targetAgentTargetId?: string | null;
  modelPlanId?: string | null;
  model?: string | null;
  contextScope?: string | null;
  resultText?: string | null;
  failureReason?: string | null;
  status: AgentActivityCollaborationStatus | (string & {});
  adoption: AgentActivityCollaborationAdoption | (string & {});
  usage?: AgentActivityCollaborationUsage | null;
  durationMs?: number | null;
  startedAtUnixMs?: number | null;
  completedAtUnixMs?: number | null;
}

export interface AgentActivitySetCollaborationAdoptionInput {
  workspaceId: string;
  agentSessionId: string;
  runId: string;
  adoption: Exclude<AgentActivityCollaborationAdoption, "not_applicable">;
  signal?: AbortSignal;
}

export interface AgentActivityModelPlanModel {
  id: string;
  name: string;
}

/** Credential-free summary of one workspace model access plan. */
export interface AgentActivityModelPlanSummary {
  id: string;
  name: string;
  protocol: string;
  enabled: boolean;
  status: string;
  models: AgentActivityModelPlanModel[];
  defaultModel?: string | null;
}
