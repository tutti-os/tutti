import {
  decideWorkspaceWorkflowCheckpoint,
  listWorkspaceWorkflows
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";
import type { TuttidClient } from "./tuttidClientTypes.ts";

type WorkspaceWorkflowClient = Pick<
  TuttidClient,
  "decideWorkspaceWorkflowCheckpoint" | "listPendingWorkspaceWorkflows"
>;

export function createWorkspaceWorkflowClient(
  client: Client
): WorkspaceWorkflowClient {
  return {
    async listPendingWorkspaceWorkflows(workspaceID, sourceSessionID) {
      const response = await listWorkspaceWorkflows({
        client,
        path: { workspaceID },
        query: {
          sourceSessionId: sourceSessionID,
          checkpointStatus: "pending"
        }
      });
      return unwrapData(response, "Workspace workflow list request failed.")
        .workflows;
    },
    async decideWorkspaceWorkflowCheckpoint(
      workspaceID,
      workflowID,
      checkpointID,
      request
    ) {
      const response = await decideWorkspaceWorkflowCheckpoint({
        client,
        body: request,
        path: { checkpointID, workflowID, workspaceID }
      });
      return unwrapData(
        response,
        "Workspace workflow decision request failed."
      );
    }
  };
}
