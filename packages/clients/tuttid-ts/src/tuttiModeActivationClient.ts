import {
  getWorkspaceAgentSessionTuttiModeActivation,
  updateWorkspaceAgentSessionTuttiModeActivation
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";
import type { TuttidClient } from "./tuttidClientTypes.ts";

type TuttiModeActivationClient = Pick<
  TuttidClient,
  | "getWorkspaceAgentSessionTuttiModeActivation"
  | "updateWorkspaceAgentSessionTuttiModeActivation"
>;

export function createTuttiModeActivationClient(
  client: Client
): TuttiModeActivationClient {
  return {
    async getWorkspaceAgentSessionTuttiModeActivation(
      workspaceID,
      agentSessionID,
      requestOptions
    ) {
      const response = await getWorkspaceAgentSessionTuttiModeActivation({
        client,
        path: { agentSessionID, workspaceID },
        ...requestOptions
      });
      return unwrapData(
        response,
        "Workspace agent Tutti mode activation request failed."
      ).activation;
    },
    async updateWorkspaceAgentSessionTuttiModeActivation(
      workspaceID,
      agentSessionID,
      request,
      requestOptions
    ) {
      const response = await updateWorkspaceAgentSessionTuttiModeActivation({
        client,
        body: request,
        path: { agentSessionID, workspaceID },
        ...requestOptions
      });
      return unwrapData(
        response,
        "Workspace agent Tutti mode activation update failed."
      );
    }
  };
}
