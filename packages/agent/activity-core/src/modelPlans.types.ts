// Model access plan contracts for the agent activity host. Split from
// types.ts to keep that module under the 800-line budget.

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
