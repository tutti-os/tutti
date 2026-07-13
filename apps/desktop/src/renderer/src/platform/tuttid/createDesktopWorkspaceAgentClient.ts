import type { TuttidClient } from "@tutti-os/client-tuttid-ts";

type ResolveTuttidClient = () => Promise<TuttidClient>;

type DesktopWorkspaceAgentClient = Pick<
  TuttidClient,
  | "goalControlWorkspaceAgentSession"
  | "listWorkspaceAgentSessionGitBranches"
  | "listWorkspaceGitBranches"
  | "readWorkspaceAgentSessionAttachment"
  | "sendWorkspaceAgentSessionInput"
  | "submitWorkspaceAgentInteractive"
  | "submitWorkspaceAgentPlanDecision"
  | "updateWorkspaceAgentSessionPin"
  | "updateWorkspaceAgentSessionSettings"
>;

export function createDesktopWorkspaceAgentClient(
  resolveClient: ResolveTuttidClient
): DesktopWorkspaceAgentClient {
  return {
    async goalControlWorkspaceAgentSession(
      workspaceID,
      agentSessionID,
      request
    ) {
      return (await resolveClient()).goalControlWorkspaceAgentSession(
        workspaceID,
        agentSessionID,
        request
      );
    },
    async sendWorkspaceAgentSessionInput(workspaceID, agentSessionID, request) {
      return (await resolveClient()).sendWorkspaceAgentSessionInput(
        workspaceID,
        agentSessionID,
        request
      );
    },
    async submitWorkspaceAgentPlanDecision(
      workspaceID,
      agentSessionID,
      turnID,
      requestID,
      request
    ) {
      return (await resolveClient()).submitWorkspaceAgentPlanDecision(
        workspaceID,
        agentSessionID,
        turnID,
        requestID,
        request
      );
    },
    async readWorkspaceAgentSessionAttachment(
      workspaceID,
      agentSessionID,
      attachmentID
    ) {
      return (await resolveClient()).readWorkspaceAgentSessionAttachment(
        workspaceID,
        agentSessionID,
        attachmentID
      );
    },
    async listWorkspaceAgentSessionGitBranches(workspaceID, agentSessionID) {
      return (await resolveClient()).listWorkspaceAgentSessionGitBranches(
        workspaceID,
        agentSessionID
      );
    },
    async listWorkspaceGitBranches(workspaceID, workingDirectory) {
      return (await resolveClient()).listWorkspaceGitBranches(
        workspaceID,
        workingDirectory
      );
    },
    async updateWorkspaceAgentSessionSettings(
      workspaceID,
      agentSessionID,
      request
    ) {
      return (await resolveClient()).updateWorkspaceAgentSessionSettings(
        workspaceID,
        agentSessionID,
        request
      );
    },
    async updateWorkspaceAgentSessionPin(workspaceID, agentSessionID, request) {
      return (await resolveClient()).updateWorkspaceAgentSessionPin(
        workspaceID,
        agentSessionID,
        request
      );
    },
    async submitWorkspaceAgentInteractive(
      workspaceID,
      agentSessionID,
      requestID,
      request
    ) {
      return (await resolveClient()).submitWorkspaceAgentInteractive(
        workspaceID,
        agentSessionID,
        requestID,
        request
      );
    }
  };
}
