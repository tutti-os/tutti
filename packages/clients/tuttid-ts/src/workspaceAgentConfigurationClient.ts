import {
  createWorkspaceAgent,
  deleteWorkspaceAgent,
  generateWorkspaceAgentDraft,
  listWorkspaceAgents,
  updateWorkspaceAgent,
  type AutomationRuleTrigger,
  type DeleteWorkspaceAgentResponse,
  type GenerateWorkspaceAgentDraftRequest,
  type ListWorkspaceAgentsResponse,
  type ModelPlanStatus,
  type PutWorkspaceAgentRequest,
  type WorkspaceAgent,
  type WorkspaceAgentDraftGeneration
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";

// Hand-written mirrors of the daemon AutomationRule contract. The curated
// OpenAPI surface only carries automation suggestions embedded in
// WorkspaceAgentDraftGeneration; once the rule CRUD schemas land in
// tuttid.v1.yaml these types should be replaced by the generated ones.
export type AutomationRuleAction = "consult" | "fork" | "delegate" | "handoff";

export type AutomationRuleTargetKind = "model" | "agent";

export type AutomationRuleTarget = {
  kind: AutomationRuleTargetKind;
  /**
   * Required for fork, delegate, and handoff. The Agent must be enabled and launchable.
   */
  workspaceAgentId?: string | null;
  /**
   * Required for consult. The ModelPlan must be enabled.
   */
  modelPlanId?: string | null;
  /**
   * Optional consult model; defaults to the target ModelPlan default model.
   */
  model?: string | null;
  requiredCapabilities: Array<string>;
};

/**
 * Authority narrowing applied to automatically launched WorkspaceAgents. Consult is always tool-free and ignores these fields.
 */
export type AutomationRulePermissions = {
  permissionModeId?: string | null;
  allowedTools: Array<string>;
};

/**
 * Independent per-source-session limit. Zero uses the daemon safety default and never means unlimited.
 */
export type AutomationRuleBudget = {
  maxRunsPerSession: number;
  maxTotalTokensPerSession: number;
};

export type AutomationRule = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  trigger: AutomationRuleTrigger;
  action: AutomationRuleAction;
  /**
   * Optional source-session Agent filter. Empty means all non-automation-origin sessions.
   */
  sourceWorkspaceAgentId?: string | null;
  target: AutomationRuleTarget;
  permissions: AutomationRulePermissions;
  budget: AutomationRuleBudget;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

export type PutAutomationRuleRequest = {
  name: string;
  enabled: boolean;
  trigger: AutomationRuleTrigger;
  action: AutomationRuleAction;
  sourceWorkspaceAgentId?: string | null;
  target: AutomationRuleTarget;
  permissions: AutomationRulePermissions;
  budget: AutomationRuleBudget;
  prompt: string;
};

/**
 * Budget and cost semantic derived from the access scheme. Subscription quota plans never expose fabricated monetary cost.
 *
 * Hand-written: the curated generated ModelPlan surface does not carry
 * billing/pricing fields yet.
 */
export type ModelPlanBillingMode = "api_metered" | "subscription_quota";

export type ModelPlanPricing = {
  currency: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cacheReadMicrosPerMillion: number;
  cacheWriteMicrosPerMillion: number;
};

/**
 * Hand-written mirror of the daemon model recommendation entry. The curated
 * OpenAPI surface does not expose the recommend endpoint yet; replace with
 * the generated type once it lands.
 */
export type WorkspaceModelRecommendation = {
  planId: string;
  planName: string;
  billingMode: ModelPlanBillingMode;
  modelId: string;
  modelName: string;
  tier?: "flagship" | "standard" | "economy";
  capabilities: Array<string>;
  pricing?: ModelPlanPricing;
  status: ModelPlanStatus;
  rank: number;
  /**
   * Stable machine-readable explanations such as status:ready, preferred_plan, default_model, capability:vision, and priced:USD.
   */
  reasons: Array<string>;
};

export interface WorkspaceAgentConfigurationClient {
  listWorkspaceAgents(
    workspaceID: string
  ): Promise<ListWorkspaceAgentsResponse>;
  createWorkspaceAgent(
    workspaceID: string,
    request: PutWorkspaceAgentRequest
  ): Promise<WorkspaceAgent>;
  generateWorkspaceAgentDraft(
    workspaceID: string,
    request: GenerateWorkspaceAgentDraftRequest
  ): Promise<WorkspaceAgentDraftGeneration>;
  updateWorkspaceAgent(
    workspaceID: string,
    workspaceAgentID: string,
    request: PutWorkspaceAgentRequest
  ): Promise<WorkspaceAgent>;
  deleteWorkspaceAgent(
    workspaceID: string,
    workspaceAgentID: string
  ): Promise<DeleteWorkspaceAgentResponse>;
}

export function createWorkspaceAgentConfigurationClient(
  client: Client
): WorkspaceAgentConfigurationClient {
  return {
    async listWorkspaceAgents(workspaceID) {
      return unwrapData(
        await listWorkspaceAgents({ client, path: { workspaceID } }),
        "Workspace Agents request failed."
      );
    },
    async createWorkspaceAgent(workspaceID, request) {
      return unwrapData(
        await createWorkspaceAgent({
          body: request,
          client,
          path: { workspaceID }
        }),
        "Create workspace Agent request failed."
      );
    },
    async generateWorkspaceAgentDraft(workspaceID, request) {
      return unwrapData(
        await generateWorkspaceAgentDraft({
          body: request,
          client,
          path: { workspaceID }
        }),
        "Generate workspace Agent draft request failed."
      );
    },
    async updateWorkspaceAgent(workspaceID, workspaceAgentID, request) {
      return unwrapData(
        await updateWorkspaceAgent({
          body: request,
          client,
          path: { workspaceAgentID, workspaceID }
        }),
        "Update workspace Agent request failed."
      );
    },
    async deleteWorkspaceAgent(workspaceID, workspaceAgentID) {
      return unwrapData(
        await deleteWorkspaceAgent({
          client,
          path: { workspaceAgentID, workspaceID }
        }),
        "Delete workspace Agent request failed."
      );
    }
  };
}
