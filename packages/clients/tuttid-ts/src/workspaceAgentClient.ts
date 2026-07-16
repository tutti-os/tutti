import {
  applyWorkspaceGitPatch,
  cancelWorkspaceAgentTurn,
  clearWorkspaceAgentSessions,
  createWorkspaceAgentSession,
  deleteWorkspaceAgentSession,
  deleteWorkspaceAgentSessionsBatch,
  getWorkspaceAgentSession,
  getWorkspaceAgentSessionGoal,
  goalControlWorkspaceAgentSession,
  importWorkspaceExternalAgentSessions,
  listWorkspaceAgentGeneratedFiles,
  listWorkspaceAgentPinnedSessionPage,
  listWorkspaceAgentSessionGitBranches,
  listWorkspaceAgentSessionMessages,
  listWorkspaceAgentSessionSectionDeletionCandidates,
  listWorkspaceAgentSessionSectionPage,
  listWorkspaceAgentSessionSections,
  listWorkspaceAgentSessions,
  listWorkspaceGitBranches,
  readWorkspaceAgentSessionAttachment,
  reconcileWorkspaceAgentSessionGoal,
  resolveWorkspaceGitPatchSupport,
  scanWorkspaceExternalAgentSessionImports,
  sendWorkspaceAgentSessionInput,
  submitWorkspaceAgentInteractive,
  submitWorkspaceAgentPlanDecision,
  updateWorkspaceAgentSessionPin,
  updateWorkspaceAgentSessionSettings,
  updateWorkspaceAgentSessionTitle,
  updateWorkspaceAgentSessionVisibility
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";
import type { TuttidClient } from "./tuttidClientTypes.ts";

type WorkspaceAgentClient = Pick<
  TuttidClient,
  | "applyWorkspaceGitPatch"
  | "cancelWorkspaceAgentTurn"
  | "clearWorkspaceAgentSessions"
  | "createWorkspaceAgentSession"
  | "deleteWorkspaceAgentSession"
  | "deleteWorkspaceAgentSessionsBatch"
  | "getWorkspaceAgentSession"
  | "getWorkspaceAgentSessionGoal"
  | "goalControlWorkspaceAgentSession"
  | "importWorkspaceExternalAgentSessions"
  | "listWorkspaceAgentGeneratedFiles"
  | "listWorkspaceAgentPinnedSessionPage"
  | "listWorkspaceAgentSessionGitBranches"
  | "listWorkspaceAgentSessionMessages"
  | "listWorkspaceAgentSessionSectionDeletionCandidates"
  | "listWorkspaceAgentSessionSectionPage"
  | "listWorkspaceAgentSessionSections"
  | "listWorkspaceAgentSessions"
  | "listWorkspaceGitBranches"
  | "readWorkspaceAgentSessionAttachment"
  | "reconcileWorkspaceAgentSessionGoal"
  | "resolveWorkspaceGitPatchSupport"
  | "scanWorkspaceExternalAgentSessionImports"
  | "sendWorkspaceAgentSessionInput"
  | "submitWorkspaceAgentInteractive"
  | "submitWorkspaceAgentPlanDecision"
  | "updateWorkspaceAgentSessionPin"
  | "updateWorkspaceAgentSessionSettings"
  | "updateWorkspaceAgentSessionTitle"
  | "updateWorkspaceAgentSessionVisibility"
>;

export function createWorkspaceAgentClient(
  client: Client
): WorkspaceAgentClient {
  return {
    async createWorkspaceAgentSession(workspaceID, request, requestOptions) {
      const response = await createWorkspaceAgentSession({
        client,
        body: request,
        path: { workspaceID },
        ...requestOptions
      });
      return unwrapData(
        response,
        "Create workspace agent session request failed."
      ).session;
    },
    async deleteWorkspaceAgentSession(workspaceID, agentSessionID) {
      return unwrapData(
        await deleteWorkspaceAgentSession({
          client,
          path: { agentSessionID, workspaceID }
        }),
        "Delete workspace agent session request failed."
      );
    },
    async deleteWorkspaceAgentSessionsBatch(
      workspaceID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await deleteWorkspaceAgentSessionsBatch({
          client,
          body: request,
          path: { workspaceID },
          ...requestOptions
        }),
        "Delete workspace agent sessions batch request failed."
      );
    },
    async clearWorkspaceAgentSessions(workspaceID) {
      return unwrapData(
        await clearWorkspaceAgentSessions({ client, path: { workspaceID } }),
        "Clear workspace agent sessions request failed."
      );
    },
    async getWorkspaceAgentSession(workspaceID, agentSessionID) {
      return unwrapData(
        await getWorkspaceAgentSession({
          client,
          path: { agentSessionID, workspaceID }
        }),
        "Workspace agent session request failed."
      );
    },
    async listWorkspaceAgentSessions(workspaceID, request, requestOptions) {
      return unwrapData(
        await listWorkspaceAgentSessions({
          client,
          path: { workspaceID },
          query: request,
          ...requestOptions
        }),
        "Workspace agent sessions request failed."
      );
    },
    async listWorkspaceAgentSessionSections(
      workspaceID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await listWorkspaceAgentSessionSections({
          client,
          path: { workspaceID },
          query: request,
          ...requestOptions
        }),
        "Workspace agent session sections request failed."
      );
    },
    async listWorkspaceAgentSessionSectionPage(
      workspaceID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await listWorkspaceAgentSessionSectionPage({
          client,
          path: { workspaceID },
          query: request,
          ...requestOptions
        }),
        "Workspace agent session section page request failed."
      );
    },
    async listWorkspaceAgentSessionSectionDeletionCandidates(
      workspaceID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await listWorkspaceAgentSessionSectionDeletionCandidates({
          client,
          path: { workspaceID },
          query: request,
          ...requestOptions
        }),
        "Workspace agent session section deletion candidates request failed."
      );
    },
    async listWorkspaceAgentPinnedSessionPage(
      workspaceID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await listWorkspaceAgentPinnedSessionPage({
          client,
          path: { workspaceID },
          query: request,
          ...requestOptions
        }),
        "Workspace pinned agent session page request failed."
      );
    },
    async listWorkspaceAgentGeneratedFiles(
      workspaceID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await listWorkspaceAgentGeneratedFiles({
          client,
          path: { workspaceID },
          query: request,
          ...requestOptions
        }),
        "Workspace agent generated files request failed."
      );
    },
    async scanWorkspaceExternalAgentSessionImports(workspaceID, request) {
      return unwrapData(
        await scanWorkspaceExternalAgentSessionImports({
          client,
          body: request,
          path: { workspaceID }
        }),
        "Workspace external agent import scan request failed."
      );
    },
    async importWorkspaceExternalAgentSessions(workspaceID, request) {
      return unwrapData(
        await importWorkspaceExternalAgentSessions({
          client,
          body: request,
          path: { workspaceID }
        }),
        "Workspace external agent import request failed."
      );
    },
    async listWorkspaceAgentSessionMessages(
      workspaceID,
      agentSessionID,
      request
    ) {
      return unwrapData(
        await listWorkspaceAgentSessionMessages({
          client,
          path: { agentSessionID, workspaceID },
          query: request
        }),
        "Workspace agent session messages request failed."
      );
    },
    async cancelWorkspaceAgentTurn(workspaceID, agentSessionID, turnID) {
      return unwrapData(
        await cancelWorkspaceAgentTurn({
          client,
          path: { agentSessionID, turnID, workspaceID }
        }),
        "Cancel workspace agent turn failed."
      );
    },
    async goalControlWorkspaceAgentSession(
      workspaceID,
      agentSessionID,
      request
    ) {
      return unwrapData(
        await goalControlWorkspaceAgentSession({
          client,
          body: request,
          path: { agentSessionID, workspaceID }
        }),
        "Goal control failed."
      );
    },
    async getWorkspaceAgentSessionGoal(workspaceID, agentSessionID) {
      return unwrapData(
        await getWorkspaceAgentSessionGoal({
          client,
          path: { agentSessionID, workspaceID }
        }),
        "Get workspace agent goal state failed."
      );
    },
    async reconcileWorkspaceAgentSessionGoal(workspaceID, agentSessionID) {
      return unwrapData(
        await reconcileWorkspaceAgentSessionGoal({
          client,
          path: { agentSessionID, workspaceID }
        }),
        "Reconcile workspace agent goal state failed."
      );
    },
    async sendWorkspaceAgentSessionInput(workspaceID, agentSessionID, request) {
      return unwrapData(
        await sendWorkspaceAgentSessionInput({
          client,
          body: request,
          path: { agentSessionID, workspaceID }
        }),
        "Send workspace agent session input failed."
      );
    },
    async submitWorkspaceAgentPlanDecision(
      workspaceID,
      agentSessionID,
      turnID,
      requestID,
      request
    ) {
      return unwrapData(
        await submitWorkspaceAgentPlanDecision({
          client,
          body: request,
          path: { agentSessionID, requestID, turnID, workspaceID }
        }),
        "Submit workspace agent plan decision failed."
      );
    },
    async readWorkspaceAgentSessionAttachment(
      workspaceID,
      agentSessionID,
      attachmentID
    ) {
      return unwrapData(
        await readWorkspaceAgentSessionAttachment({
          client,
          path: { agentSessionID, attachmentID, workspaceID }
        }),
        "Read workspace agent session attachment failed."
      );
    },
    async listWorkspaceAgentSessionGitBranches(workspaceID, agentSessionID) {
      return unwrapData(
        await listWorkspaceAgentSessionGitBranches({
          client,
          path: { agentSessionID, workspaceID }
        }),
        "List workspace agent session git branches failed."
      );
    },
    async listWorkspaceGitBranches(workspaceID, workingDirectory) {
      return unwrapData(
        await listWorkspaceGitBranches({
          client,
          path: { workspaceID },
          query: { workingDirectory }
        }),
        "List workspace git branches failed."
      );
    },
    async resolveWorkspaceGitPatchSupport(workspaceID, cwd) {
      return unwrapData(
        await resolveWorkspaceGitPatchSupport({
          client,
          path: { workspaceID },
          query: { cwd }
        }),
        "Resolve workspace git patch support failed."
      );
    },
    async applyWorkspaceGitPatch(workspaceID, request) {
      return unwrapData(
        await applyWorkspaceGitPatch({
          client,
          body: request,
          path: { workspaceID }
        }),
        "Apply workspace git patch failed."
      );
    },
    async updateWorkspaceAgentSessionSettings(
      workspaceID,
      agentSessionID,
      request
    ) {
      return unwrapData(
        await updateWorkspaceAgentSessionSettings({
          client,
          body: request,
          path: { agentSessionID, workspaceID }
        }),
        "Update workspace agent session settings failed."
      ).session;
    },
    async updateWorkspaceAgentSessionPin(workspaceID, agentSessionID, request) {
      return unwrapData(
        await updateWorkspaceAgentSessionPin({
          client,
          body: request,
          path: { agentSessionID, workspaceID }
        }),
        "Update workspace agent session pin failed."
      ).session;
    },
    async updateWorkspaceAgentSessionTitle(
      workspaceID,
      agentSessionID,
      request
    ) {
      return unwrapData(
        await updateWorkspaceAgentSessionTitle({
          client,
          body: request,
          path: { agentSessionID, workspaceID }
        }),
        "Update workspace agent session title failed."
      ).session;
    },
    async updateWorkspaceAgentSessionVisibility(
      workspaceID,
      agentSessionID,
      request
    ) {
      return unwrapData(
        await updateWorkspaceAgentSessionVisibility({
          client,
          body: request,
          path: { agentSessionID, workspaceID }
        }),
        "Update workspace agent session visibility failed."
      ).session;
    },
    async submitWorkspaceAgentInteractive(
      workspaceID,
      agentSessionID,
      requestID,
      request
    ) {
      return unwrapData(
        await submitWorkspaceAgentInteractive({
          client,
          body: request,
          path: { agentSessionID, requestID, workspaceID }
        }),
        "Submit workspace agent interactive response failed."
      ).session;
    }
  };
}
