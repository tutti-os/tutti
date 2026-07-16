import {
  createWorkspaceIssueFromPlan,
  estimateWorkspaceIssueAutoTokenBudget,
  type CreateIssueManagerIssueFromPlanRequest,
  type EstimateIssueManagerAutoTokenBudgetRequest,
  type IssueManagerAutoTokenBudgetEstimate,
  type IssueManagerIssueDetailResponse
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";

export interface WorkspaceIssueOrchestrationClient {
  createWorkspaceIssueFromPlan?(
    workspaceID: string,
    request: CreateIssueManagerIssueFromPlanRequest
  ): Promise<IssueManagerIssueDetailResponse>;
  estimateWorkspaceIssueAutoTokenBudget?(
    workspaceID: string,
    request: EstimateIssueManagerAutoTokenBudgetRequest
  ): Promise<IssueManagerAutoTokenBudgetEstimate>;
}

export function createWorkspaceIssueOrchestrationClient(
  client: Client
): WorkspaceIssueOrchestrationClient {
  return {
    async createWorkspaceIssueFromPlan(workspaceID, request) {
      const response = await createWorkspaceIssueFromPlan({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Create workspace issue from plan request failed."
      );
    },
    async estimateWorkspaceIssueAutoTokenBudget(workspaceID, request) {
      const response = await estimateWorkspaceIssueAutoTokenBudget({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Estimate workspace issue auto token budget request failed."
      );
    }
  };
}
