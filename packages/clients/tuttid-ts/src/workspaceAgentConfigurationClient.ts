import {
  createAutomationRule,
  createWorkspaceAgent,
  deleteAutomationRule,
  deleteWorkspaceAgent,
  generateWorkspaceAgentDraft,
  getAgentSessionAutomationRuleOverride,
  getAutomationRule,
  listAutomationRules,
  listModelPlans,
  listWorkspaceAgents,
  setAgentSessionAutomationRuleOverride,
  updateAutomationRule,
  updateWorkspaceAgent,
  type AgentSessionAutomationRuleOverride,
  type AutomationRule,
  type DeleteAutomationRuleResponse,
  type DeleteWorkspaceAgentResponse,
  type GenerateWorkspaceAgentDraftRequest,
  type ListAutomationRulesResponse,
  type ListModelPlansResponse,
  type ListWorkspaceAgentsResponse,
  type PutAutomationRuleRequest,
  type PutWorkspaceAgentRequest,
  type SetAgentSessionAutomationRuleOverrideRequest,
  type WorkspaceAgent,
  type WorkspaceAgentDraftGeneration
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
    }
  };
}
