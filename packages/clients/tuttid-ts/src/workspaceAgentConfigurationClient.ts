import {
  createAutomationRule,
  getAgentSessionAutomationRuleOverride,
  setAgentSessionAutomationRuleOverride,
  createWorkspaceAgent,
  deleteAutomationRule,
  deleteWorkspaceAgent,
  listAutomationRules,
  listModelPlans,
  listWorkspaceAgents,
  updateAutomationRule,
  updateWorkspaceAgent,
  type AutomationRule,
  type AgentSessionAutomationRuleOverride,
  type ListAutomationRulesResponse,
  type PutAutomationRuleRequest,
  type SetAgentSessionAutomationRuleOverrideRequest,
  type DeleteWorkspaceAgentResponse,
  type ListModelPlansResponse,
  type ListWorkspaceAgentsResponse,
  type ModelPlanStatus,
  type PutWorkspaceAgentRequest,
  type WorkspaceAgent
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";

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
  listAutomationRules(
    workspaceID: string
  ): Promise<ListAutomationRulesResponse>;
  createAutomationRule(
    workspaceID: string,
    request: PutAutomationRuleRequest
  ): Promise<AutomationRule>;
  updateAutomationRule(
    workspaceID: string,
    automationRuleID: string,
    request: PutAutomationRuleRequest
  ): Promise<AutomationRule>;
  deleteAutomationRule(
    workspaceID: string,
    automationRuleID: string
  ): Promise<void>;
  getAgentSessionAutomationRuleOverride(
    workspaceID: string,
    agentSessionID: string
  ): Promise<AgentSessionAutomationRuleOverride>;
  setAgentSessionAutomationRuleOverride(
    workspaceID: string,
    agentSessionID: string,
    request: SetAgentSessionAutomationRuleOverrideRequest
  ): Promise<AgentSessionAutomationRuleOverride>;
  listModelPlans(workspaceID: string): Promise<ListModelPlansResponse>;
  listWorkspaceAgents(
    workspaceID: string
  ): Promise<ListWorkspaceAgentsResponse>;
  createWorkspaceAgent(
    workspaceID: string,
    request: PutWorkspaceAgentRequest
  ): Promise<WorkspaceAgent>;
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
    async listAutomationRules(workspaceID) {
      return unwrapData(
        await listAutomationRules({ client, path: { workspaceID } }),
        "Automation rules request failed."
      );
    },
    async createAutomationRule(workspaceID, request) {
      return unwrapData(
        await createAutomationRule({
          body: request,
          client,
          path: { workspaceID }
        }),
        "Create automation rule request failed."
      );
    },
    async updateAutomationRule(workspaceID, automationRuleID, request) {
      return unwrapData(
        await updateAutomationRule({
          body: request,
          client,
          path: { automationRuleID, workspaceID }
        }),
        "Update automation rule request failed."
      );
    },
    async deleteAutomationRule(workspaceID, automationRuleID) {
      await deleteAutomationRule({
        client,
        path: { automationRuleID, workspaceID },
        throwOnError: true
      });
    },
    async getAgentSessionAutomationRuleOverride(workspaceID, agentSessionID) {
      return unwrapData(
        await getAgentSessionAutomationRuleOverride({
          client,
          path: { agentSessionID, workspaceID }
        }),
        "Automation rule override request failed."
      );
    },
    async setAgentSessionAutomationRuleOverride(
      workspaceID,
      agentSessionID,
      request
    ) {
      return unwrapData(
        await setAgentSessionAutomationRuleOverride({
          body: request,
          client,
          path: { agentSessionID, workspaceID }
        }),
        "Set automation rule override request failed."
      );
    },
    async listModelPlans(workspaceID) {
      return unwrapData(
        await listModelPlans({ client, path: { workspaceID } }),
        "Model plans request failed."
      );
    },
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
