import {
  createAutomationRule,
  createModelPlan,
  createWorkspaceAgent,
  deleteAutomationRule,
  deleteModelPlan,
  deleteWorkspaceAgent,
  detectModelPlan,
  duplicateModelPlan,
  getAgentSessionAutomationRuleOverride,
  getAutomationRule,
  getModelPlan,
  listAgentModelBindings,
  listAutomationRules,
  listModelPlanReferences,
  listModelPlans,
  listWorkspaceAgents,
  recommendWorkspaceModels,
  setAgentModelBinding,
  setAgentSessionAutomationRuleOverride,
  setModelPlanEnabled,
  updateAutomationRule,
  updateModelPlan,
  updateWorkspaceAgent,
  type AgentModelBinding,
  type AgentSessionAutomationRuleOverride,
  type AutomationRule,
  type DeleteModelPlanResponse,
  type DeleteAutomationRuleResponse,
  type DeleteWorkspaceAgentResponse,
  type DetectModelPlanRequest,
  type DetectModelPlanResponse,
  type DuplicateModelPlanRequest,
  type ListAgentModelBindingsResponse,
  type ListAutomationRulesResponse,
  type ListModelPlansResponse,
  type ListWorkspaceAgentsResponse,
  type ModelPlan,
  type ModelPlanReferencesResponse,
  type PutModelPlanRequest,
  type PutAutomationRuleRequest,
  type PutWorkspaceAgentRequest,
  type RecommendWorkspaceModelsRequest,
  type RecommendWorkspaceModelsResponse,
  type SetAgentModelBindingRequest,
  type SetAgentSessionAutomationRuleOverrideRequest,
  type SetModelPlanEnabledRequest,
  type WorkspaceAgent
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";

export interface WorkspaceAgentConfigurationClient {
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
  listAutomationRules(
    workspaceID: string
  ): Promise<ListAutomationRulesResponse>;
  getAutomationRule(
    workspaceID: string,
    automationRuleID: string
  ): Promise<AutomationRule>;
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
  ): Promise<DeleteAutomationRuleResponse>;
  getAgentSessionAutomationRuleOverride(
    workspaceID: string,
    agentSessionID: string
  ): Promise<AgentSessionAutomationRuleOverride>;
  setAgentSessionAutomationRuleOverride(
    workspaceID: string,
    agentSessionID: string,
    request: SetAgentSessionAutomationRuleOverrideRequest
  ): Promise<AgentSessionAutomationRuleOverride>;
  listWorkspaceModelPlans(workspaceID: string): Promise<ListModelPlansResponse>;
  createModelPlan(
    workspaceID: string,
    request: PutModelPlanRequest
  ): Promise<ModelPlan>;
  detectModelPlan(
    workspaceID: string,
    request: DetectModelPlanRequest
  ): Promise<DetectModelPlanResponse>;
  recommendWorkspaceModels(
    workspaceID: string,
    request: RecommendWorkspaceModelsRequest
  ): Promise<RecommendWorkspaceModelsResponse>;
  deleteModelPlan(
    workspaceID: string,
    modelPlanID: string
  ): Promise<DeleteModelPlanResponse>;
  getModelPlan(workspaceID: string, modelPlanID: string): Promise<ModelPlan>;
  updateModelPlan(
    workspaceID: string,
    modelPlanID: string,
    request: PutModelPlanRequest
  ): Promise<ModelPlan>;
  duplicateModelPlan(
    workspaceID: string,
    modelPlanID: string,
    request?: DuplicateModelPlanRequest
  ): Promise<ModelPlan>;
  setModelPlanEnabled(
    workspaceID: string,
    modelPlanID: string,
    request: SetModelPlanEnabledRequest
  ): Promise<ModelPlan>;
  listModelPlanReferences(
    workspaceID: string,
    modelPlanID: string
  ): Promise<ModelPlanReferencesResponse>;
  listAgentModelBindings(
    workspaceID: string
  ): Promise<ListAgentModelBindingsResponse>;
  setAgentModelBinding(
    workspaceID: string,
    agentTargetID: string,
    request: SetAgentModelBindingRequest
  ): Promise<AgentModelBinding>;
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
    },
    async listAutomationRules(workspaceID) {
      return unwrapData(
        await listAutomationRules({ client, path: { workspaceID } }),
        "Automation rules request failed."
      );
    },
    async getAutomationRule(workspaceID, automationRuleID) {
      return unwrapData(
        await getAutomationRule({
          client,
          path: { automationRuleID, workspaceID }
        }),
        "Automation rule request failed."
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
      return unwrapData(
        await deleteAutomationRule({
          client,
          path: { automationRuleID, workspaceID }
        }),
        "Delete automation rule request failed."
      );
    },
    async getAgentSessionAutomationRuleOverride(workspaceID, agentSessionID) {
      return unwrapData(
        await getAgentSessionAutomationRuleOverride({
          client,
          path: { agentSessionID, workspaceID }
        }),
        "Agent session automation override request failed."
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
        "Update agent session automation override request failed."
      );
    },
    async listWorkspaceModelPlans(workspaceID) {
      const response = await listModelPlans({ client, path: { workspaceID } });
      return unwrapData(response, "Workspace model plans request failed.");
    },
    async createModelPlan(workspaceID, request) {
      return unwrapData(
        await createModelPlan({ body: request, client, path: { workspaceID } }),
        "Create model plan request failed."
      );
    },
    async detectModelPlan(workspaceID, request) {
      return unwrapData(
        await detectModelPlan({ body: request, client, path: { workspaceID } }),
        "Detect model plan request failed."
      );
    },
    async recommendWorkspaceModels(workspaceID, request) {
      return unwrapData(
        await recommendWorkspaceModels({
          body: request,
          client,
          path: { workspaceID }
        }),
        "Recommend workspace models request failed."
      );
    },
    async deleteModelPlan(workspaceID, modelPlanID) {
      return unwrapData(
        await deleteModelPlan({
          client,
          path: { modelPlanID, workspaceID }
        }),
        "Delete model plan request failed."
      );
    },
    async getModelPlan(workspaceID, modelPlanID) {
      return unwrapData(
        await getModelPlan({ client, path: { modelPlanID, workspaceID } }),
        "Get model plan request failed."
      );
    },
    async updateModelPlan(workspaceID, modelPlanID, request) {
      return unwrapData(
        await updateModelPlan({
          body: request,
          client,
          path: { modelPlanID, workspaceID }
        }),
        "Update model plan request failed."
      );
    },
    async duplicateModelPlan(workspaceID, modelPlanID, request = {}) {
      return unwrapData(
        await duplicateModelPlan({
          body: request,
          client,
          path: { modelPlanID, workspaceID }
        }),
        "Duplicate model plan request failed."
      );
    },
    async setModelPlanEnabled(workspaceID, modelPlanID, request) {
      return unwrapData(
        await setModelPlanEnabled({
          body: request,
          client,
          path: { modelPlanID, workspaceID }
        }),
        "Update model plan enabled state request failed."
      );
    },
    async listModelPlanReferences(workspaceID, modelPlanID) {
      return unwrapData(
        await listModelPlanReferences({
          client,
          path: { modelPlanID, workspaceID }
        }),
        "Model plan references request failed."
      );
    },
    async listAgentModelBindings(workspaceID) {
      return unwrapData(
        await listAgentModelBindings({ client, path: { workspaceID } }),
        "Agent model bindings request failed."
      );
    },
    async setAgentModelBinding(workspaceID, agentTargetID, request) {
      return unwrapData(
        await setAgentModelBinding({
          body: request,
          client,
          path: { agentTargetID, workspaceID }
        }),
        "Update agent model binding request failed."
      );
    }
  };
}
