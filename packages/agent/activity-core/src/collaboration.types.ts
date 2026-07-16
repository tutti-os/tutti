export type AgentActivityCollaborationMode =
  | "consult"
  | "fork"
  | "delegate"
  | "handoff";

export type AgentActivityCollaborationTriggerSource =
  | "user"
  | "agent"
  | "policy"
  | "automation";

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
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  retryOfRunId?: string | null;
  attempt: number;
  resultText?: string | null;
  failureReason?: string | null;
  failureStage?: string | null;
  status: AgentActivityCollaborationStatus | (string & {});
  adoption: AgentActivityCollaborationAdoption | (string & {});
  usage?: AgentActivityCollaborationUsage | null;
  cost?: {
    currency: string;
    estimatedMicros: number;
  } | null;
  durationMs?: number | null;
  startedAtUnixMs?: number | null;
  completedAtUnixMs?: number | null;
}

export interface AgentActivityStartModelConsultInput {
  workspaceId: string;
  agentSessionId: string;
  modelPlanId: string;
  model: string;
  question: string;
  contextText?: string | null;
  signal?: AbortSignal;
}

export interface AgentActivityStartAgentCollaborationInput {
  workspaceId: string;
  agentSessionId: string;
  targetAgentTargetId: string;
  mode: Exclude<AgentActivityCollaborationMode, "consult">;
  question: string;
  contextScope: "none" | "recent" | "full";
  contextText?: string | null;
  modelPlanId?: string | null;
  model?: string | null;
  triggerReason?: string | null;
  signal?: AbortSignal;
}

export interface AgentActivitySetCollaborationAdoptionInput {
  workspaceId: string;
  agentSessionId: string;
  runId: string;
  adoption: Exclude<AgentActivityCollaborationAdoption, "not_applicable">;
  signal?: AbortSignal;
}

export interface AgentActivityCancelCollaborationInput {
  workspaceId: string;
  runId: string;
  signal?: AbortSignal;
}

export interface AgentActivityRetryCollaborationInput {
  workspaceId: string;
  runId: string;
  signal?: AbortSignal;
}

export interface AgentActivityModelPlanModel {
  id: string;
  name: string;
  tier?: "flagship" | "standard" | "economy" | string;
  capabilities?: string[];
  pricing?: {
    currency: string;
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
    cacheReadMicrosPerMillion: number;
    cacheWriteMicrosPerMillion: number;
  } | null;
}

/** Credential-free summary of one workspace model access plan. */
export interface AgentActivityModelPlanSummary {
  id: string;
  name: string;
  billingMode?: "api_metered" | "subscription_quota" | string;
  protocol: string;
  enabled: boolean;
  status: string;
  models: AgentActivityModelPlanModel[];
  defaultModel?: string | null;
}

export interface AgentActivityListModelPlansInput {
  workspaceId: string;
  signal?: AbortSignal;
}

export interface AgentActivityListModelPlansResult {
  plans: AgentActivityModelPlanSummary[];
}
