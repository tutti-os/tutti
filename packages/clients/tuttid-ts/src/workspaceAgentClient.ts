import {
  acknowledgeWorkspaceAgentSessionForkOperation,
  appendAgentSessionRecordingActivityEvents,
  applyWorkspaceGitPatch,
  cancelAgentSessionRecording,
  cancelWorkspaceAgentTurn,
  cancelWorkspaceAgentSideConversationTurn,
  closeWorkspaceAgentSideConversation,
  clearWorkspaceAgentSessions,
  completeAgentSessionRecording,
  createWorkspaceAgentSession,
  deleteAgentSessionRecording,
  deleteWorkspaceAgentSession,
  deleteWorkspaceAgentSessionsBatch,
  deleteWorkspaceManagedWorktree,
  forkWorkspaceAgentSession,
  getWorkspaceAgentSessionForkOperation,
  editRetryWorkspaceAgentTurn,
  getWorkspaceAgentSession,
  getAgentSessionRecording,
  getAgentSessionReplayTransportPlayback,
  getWorkspaceAgentSessionGoal,
  goalControlWorkspaceAgentSession,
  importAgentSessionCassettes,
  importWorkspaceExternalAgentSessions,
  listWorkspaceAgentGeneratedFiles,
  listAgentSessionRecordings,
  listWorkspaceAgentPinnedSessionPage,
  listWorkspaceAgentSessionGitBranches,
  listWorkspaceAgentSessionMessages,
  listWorkspaceAgentSessionSectionDeletionCandidates,
  listWorkspaceAgentSessionSectionPage,
  listWorkspaceAgentSessionSections,
  listWorkspaceAgentSessions,
  listWorkspaceDeletedAgentSessions,
  listWorkspaceGitBranches,
  listWorkspaceManagedWorktrees,
  purgeWorkspaceDeletedAgentSession,
  purgeWorkspaceDeletedAgentSessions,
  readWorkspaceAgentSessionAttachment,
  recoverWorkspaceAgentEditRetry,
  resolveWorkspaceAgentSideCapabilities,
  renameAgentSessionRecording,
  restoreWorkspaceDeletedAgentSession,
  reconcileWorkspaceAgentSessionGoal,
  prepareAgentSessionReplayWorkspace,
  resolveWorkspaceGitPatchSupport,
  resolveWorkspaceAgentSessionWorktreeSupport,
  scanWorkspaceExternalAgentSessionImports,
  sendWorkspaceAgentSessionInput,
  sendWorkspaceAgentSideConversationInput,
  startAgentSessionRecording,
  submitWorkspaceAgentInteractive,
  submitWorkspaceAgentSideConversationInteractive,
  openWorkspaceAgentSideConversation,
  submitWorkspaceAgentPlanDecision,
  updateWorkspaceAgentSessionPin,
  updateAgentSessionReplayTransportPlayback,
  updateWorkspaceAgentSessionSettings,
  updateWorkspaceAgentSessionTitle,
  updateWorkspaceAgentSessionVisibility
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapAccepted, unwrapData } from "./tuttidClientResponse.ts";
import type {
  AgentCommandRequestOptions,
  TuttidClient
} from "./tuttidClientTypes.ts";

type WorkspaceAgentClient = Pick<
  TuttidClient,
  | "acknowledgeWorkspaceAgentSessionForkOperation"
  | "appendAgentSessionRecordingActivityEvents"
  | "applyWorkspaceGitPatch"
  | "cancelAgentSessionRecording"
  | "cancelWorkspaceAgentTurn"
  | "cancelWorkspaceAgentSideConversationTurn"
  | "closeWorkspaceAgentSideConversation"
  | "clearWorkspaceAgentSessions"
  | "completeAgentSessionRecording"
  | "createWorkspaceAgentSession"
  | "deleteAgentSessionRecording"
  | "deleteWorkspaceAgentSession"
  | "deleteWorkspaceAgentSessionsBatch"
  | "deleteWorkspaceManagedWorktree"
  | "forkWorkspaceAgentSession"
  | "getWorkspaceAgentSessionForkOperation"
  | "editRetry"
  | "getWorkspaceAgentSession"
  | "getAgentSessionRecording"
  | "getAgentSessionReplayTransportPlayback"
  | "getWorkspaceAgentSessionGoal"
  | "goalControlWorkspaceAgentSession"
  | "importAgentSessionCassettes"
  | "importWorkspaceExternalAgentSessions"
  | "listWorkspaceAgentGeneratedFiles"
  | "listAgentSessionRecordings"
  | "listWorkspaceAgentPinnedSessionPage"
  | "listWorkspaceAgentSessionGitBranches"
  | "listWorkspaceAgentSessionMessages"
  | "listWorkspaceAgentSessionSectionDeletionCandidates"
  | "listWorkspaceAgentSessionSectionPage"
  | "listWorkspaceAgentSessionSections"
  | "listWorkspaceAgentSessions"
  | "listWorkspaceDeletedAgentSessions"
  | "listWorkspaceGitBranches"
  | "listWorkspaceManagedWorktrees"
  | "purgeWorkspaceDeletedAgentSession"
  | "purgeWorkspaceDeletedAgentSessions"
  | "readWorkspaceAgentSessionAttachment"
  | "recoverEditRetry"
  | "resolveWorkspaceAgentSideCapabilities"
  | "renameAgentSessionRecording"
  | "restoreWorkspaceDeletedAgentSession"
  | "reconcileWorkspaceAgentSessionGoal"
  | "prepareAgentSessionReplayWorkspace"
  | "resolveWorkspaceGitPatchSupport"
  | "resolveWorkspaceAgentSessionWorktreeSupport"
  | "scanWorkspaceExternalAgentSessionImports"
  | "sendWorkspaceAgentSessionInput"
  | "sendWorkspaceAgentSideConversationInput"
  | "startAgentSessionRecording"
  | "submitWorkspaceAgentInteractive"
  | "submitWorkspaceAgentSideConversationInteractive"
  | "openWorkspaceAgentSideConversation"
  | "submitWorkspaceAgentPlanDecision"
  | "updateWorkspaceAgentSessionPin"
  | "updateAgentSessionReplayTransportPlayback"
  | "updateWorkspaceAgentSessionSettings"
  | "updateWorkspaceAgentSessionTitle"
  | "updateWorkspaceAgentSessionVisibility"
>;

export function createWorkspaceAgentClient(
  client: Client
): WorkspaceAgentClient {
  return {
    async acknowledgeWorkspaceAgentSessionForkOperation(
      workspaceID,
      operationID,
      requestOptions
    ) {
      return unwrapData(
        await acknowledgeWorkspaceAgentSessionForkOperation({
          client,
          path: { operationID, workspaceID },
          ...requestOptions
        }),
        "Acknowledge workspace agent session fork operation request failed."
      ).operation;
    },
    async appendAgentSessionRecordingActivityEvents(
      workspaceID,
      recordingID,
      request
    ) {
      return unwrapData(
        await appendAgentSessionRecordingActivityEvents({
          client,
          body: request,
          path: { recordingID, workspaceID }
        }),
        "Append agent session recording activity events request failed."
      );
    },
    async listAgentSessionRecordings(workspaceID) {
      return unwrapData(
        await listAgentSessionRecordings({
          client,
          path: { workspaceID }
        }),
        "List agent session recordings request failed."
      ).recordings;
    },
    async importAgentSessionCassettes(workspaceID, request) {
      return unwrapData(
        await importAgentSessionCassettes({
          client,
          body: request,
          path: { workspaceID }
        }),
        "Import agent session cassettes request failed."
      );
    },
    async startAgentSessionRecording(workspaceID, request) {
      return unwrapData(
        await startAgentSessionRecording({
          client,
          body: request,
          path: { workspaceID }
        }),
        "Start agent session recording request failed."
      );
    },
    async getAgentSessionRecording(workspaceID, recordingID) {
      return unwrapData(
        await getAgentSessionRecording({
          client,
          path: { recordingID, workspaceID }
        }),
        "Get agent session recording request failed."
      );
    },
    async renameAgentSessionRecording(workspaceID, recordingID, request) {
      return unwrapData(
        await renameAgentSessionRecording({
          client,
          body: request,
          path: { recordingID, workspaceID }
        }),
        "Rename agent session recording request failed."
      );
    },
    async deleteAgentSessionRecording(workspaceID, recordingID) {
      unwrapAccepted(
        await deleteAgentSessionRecording({
          client,
          path: { recordingID, workspaceID }
        }),
        "Delete agent session recording request failed."
      );
    },
    async completeAgentSessionRecording(workspaceID, recordingID) {
      return unwrapData(
        await completeAgentSessionRecording({
          client,
          path: { recordingID, workspaceID }
        }),
        "Complete agent session recording request failed."
      );
    },
    async cancelAgentSessionRecording(workspaceID, recordingID) {
      return unwrapData(
        await cancelAgentSessionRecording({
          client,
          path: { recordingID, workspaceID }
        }),
        "Cancel agent session recording request failed."
      );
    },
    async prepareAgentSessionReplayWorkspace(workspaceID, request) {
      return unwrapData(
        await prepareAgentSessionReplayWorkspace({
          body: request,
          client,
          path: { workspaceID }
        }),
        "Prepare agent session replay workspace request failed."
      );
    },
    async getAgentSessionReplayTransportPlayback(cassetteID) {
      const response = await getAgentSessionReplayTransportPlayback({
        client,
        path: { cassetteID }
      });
      if (response.response?.status === 503) {
        return null;
      }
      return unwrapData(
        response,
        "Get agent session replay transport playback request failed."
      );
    },
    async updateAgentSessionReplayTransportPlayback(cassetteID, request) {
      return unwrapData(
        await updateAgentSessionReplayTransportPlayback({
          body: request,
          client,
          path: { cassetteID }
        }),
        "Update agent session replay transport playback request failed."
      );
    },
    async createWorkspaceAgentSession(workspaceID, request, requestOptions) {
      const response = await createWorkspaceAgentSession({
        client,
        body: request,
        path: { workspaceID },
        ...agentCommandRequestOptions(requestOptions)
      });
      return unwrapData(
        response,
        "Create workspace agent session request failed."
      ).session;
    },
    async forkWorkspaceAgentSession(
      workspaceID,
      agentSessionID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await forkWorkspaceAgentSession({
          client,
          body: request,
          path: { agentSessionID, workspaceID },
          ...requestOptions
        }),
        "Fork workspace agent session request failed."
      ).operation;
    },
    async resolveWorkspaceAgentSideCapabilities(workspaceID, agentSessionID) {
      return unwrapData(
        await resolveWorkspaceAgentSideCapabilities({
          client,
          path: { agentSessionID, workspaceID }
        }),
        "Resolve workspace agent Side capabilities request failed."
      ).capabilities;
    },
    async openWorkspaceAgentSideConversation(
      workspaceID,
      agentSessionID,
      request
    ) {
      return unwrapData(
        await openWorkspaceAgentSideConversation({
          client,
          body: request,
          path: { agentSessionID, workspaceID }
        }),
        "Open workspace agent Side conversation request failed."
      ).side;
    },
    async closeWorkspaceAgentSideConversation(workspaceID, sideAgentSessionID) {
      unwrapData(
        await closeWorkspaceAgentSideConversation({
          client,
          path: { sideAgentSessionID, workspaceID }
        }),
        "Close workspace agent Side conversation request failed."
      );
    },
    async sendWorkspaceAgentSideConversationInput(
      workspaceID,
      sideAgentSessionID,
      request
    ) {
      return unwrapData(
        await sendWorkspaceAgentSideConversationInput({
          client,
          body: request,
          path: { sideAgentSessionID, workspaceID }
        }),
        "Send workspace agent Side conversation input request failed."
      );
    },
    async cancelWorkspaceAgentSideConversationTurn(
      workspaceID,
      sideAgentSessionID,
      turnID
    ) {
      return unwrapData(
        await cancelWorkspaceAgentSideConversationTurn({
          client,
          path: { sideAgentSessionID, turnID, workspaceID }
        }),
        "Cancel workspace agent Side conversation turn request failed."
      );
    },
    async submitWorkspaceAgentSideConversationInteractive(
      workspaceID,
      sideAgentSessionID,
      turnID,
      requestID,
      request
    ) {
      return unwrapData(
        await submitWorkspaceAgentSideConversationInteractive({
          client,
          body: request,
          path: {
            requestID,
            sideAgentSessionID,
            turnID,
            workspaceID
          }
        }),
        "Submit workspace agent Side interactive response failed."
      );
    },
    async getWorkspaceAgentSessionForkOperation(
      workspaceID,
      operationID,
      requestOptions
    ) {
      return unwrapData(
        await getWorkspaceAgentSessionForkOperation({
          client,
          path: { operationID, workspaceID },
          ...requestOptions
        }),
        "Get workspace agent session fork operation request failed."
      ).operation;
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
    async listWorkspaceDeletedAgentSessions(
      workspaceID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await listWorkspaceDeletedAgentSessions({
          client,
          path: { workspaceID },
          query: request,
          ...requestOptions
        }),
        "List workspace deleted agent sessions request failed."
      );
    },
    async restoreWorkspaceDeletedAgentSession(
      workspaceID,
      agentSessionID,
      requestOptions
    ) {
      return unwrapData(
        await restoreWorkspaceDeletedAgentSession({
          client,
          path: { agentSessionID, workspaceID },
          ...requestOptions
        }),
        "Restore workspace deleted agent session request failed."
      );
    },
    async purgeWorkspaceDeletedAgentSession(
      workspaceID,
      agentSessionID,
      requestOptions
    ) {
      return unwrapData(
        await purgeWorkspaceDeletedAgentSession({
          client,
          path: { agentSessionID, workspaceID },
          ...requestOptions
        }),
        "Purge workspace deleted agent session request failed."
      );
    },
    async purgeWorkspaceDeletedAgentSessions(workspaceID, requestOptions) {
      return unwrapData(
        await purgeWorkspaceDeletedAgentSessions({
          client,
          path: { workspaceID },
          ...requestOptions
        }),
        "Purge workspace deleted agent sessions request failed."
      );
    },
    async getWorkspaceAgentSession(
      workspaceID,
      agentSessionID,
      projection,
      requestOptions
    ) {
      const expectedProjection = projection ?? "full";
      const detail = unwrapData(
        await getWorkspaceAgentSession({
          client,
          path: { agentSessionID, workspaceID },
          query: projection === undefined ? undefined : { projection },
          ...requestOptions
        }),
        "Workspace agent session request failed."
      );
      if (detail.projection !== expectedProjection) {
        throw new Error(
          `Workspace agent session projection mismatch: requested ${expectedProjection}, received ${detail.projection}.`
        );
      }
      if (
        detail.lifecycleCapabilitiesProjected !==
        (expectedProjection === "full")
      ) {
        throw new Error(
          `Workspace agent session lifecycle capability projection does not match detail projection ${expectedProjection}.`
        );
      }
      return detail;
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
      request,
      requestOptions
    ) {
      return unwrapData(
        await listWorkspaceAgentSessionMessages({
          client,
          path: { agentSessionID, workspaceID },
          query: request,
          ...requestOptions
        }),
        "Workspace agent session messages request failed."
      );
    },
    async cancelWorkspaceAgentTurn(
      workspaceID,
      agentSessionID,
      turnID,
      requestOptions
    ) {
      return unwrapData(
        await cancelWorkspaceAgentTurn({
          client,
          path: { agentSessionID, turnID, workspaceID },
          ...agentCommandRequestOptions(requestOptions)
        }),
        "Cancel workspace agent turn failed."
      );
    },
    async editRetry(
      workspaceID,
      agentSessionID,
      turnID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await editRetryWorkspaceAgentTurn({
          client,
          body: request,
          path: { agentSessionID, turnID, workspaceID },
          ...requestOptions
        }),
        "Edit and retry request failed."
      );
    },
    async recoverEditRetry(
      workspaceID,
      agentSessionID,
      operationID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await recoverWorkspaceAgentEditRetry({
          client,
          body: request,
          path: { agentSessionID, operationID, workspaceID },
          ...requestOptions
        }),
        "Edit and retry recovery failed."
      );
    },
    async goalControlWorkspaceAgentSession(
      workspaceID,
      agentSessionID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await goalControlWorkspaceAgentSession({
          client,
          body: request,
          path: { agentSessionID, workspaceID },
          ...agentCommandRequestOptions(requestOptions)
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
    async sendWorkspaceAgentSessionInput(
      workspaceID,
      agentSessionID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await sendWorkspaceAgentSessionInput({
          client,
          body: request,
          path: { agentSessionID, workspaceID },
          ...agentCommandRequestOptions(requestOptions)
        }),
        "Send workspace agent session input failed."
      );
    },
    async submitWorkspaceAgentPlanDecision(
      workspaceID,
      agentSessionID,
      turnID,
      requestID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await submitWorkspaceAgentPlanDecision({
          client,
          body: request,
          path: { agentSessionID, requestID, turnID, workspaceID },
          ...agentCommandRequestOptions(requestOptions)
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
    async resolveWorkspaceAgentSessionWorktreeSupport(
      workspaceID,
      agentTargetId,
      cwd
    ) {
      return unwrapData(
        await resolveWorkspaceAgentSessionWorktreeSupport({
          client,
          path: { workspaceID },
          query: { agentTargetId, cwd }
        }),
        "Resolve workspace Agent Session worktree support failed."
      );
    },
    async listWorkspaceManagedWorktrees(workspaceID) {
      return unwrapData(
        await listWorkspaceManagedWorktrees({
          client,
          path: { workspaceID }
        }),
        "List workspace managed worktrees failed."
      );
    },
    async deleteWorkspaceManagedWorktree(workspaceID, worktreeID) {
      return unwrapData(
        await deleteWorkspaceManagedWorktree({
          client,
          path: { workspaceID, worktreeID }
        }),
        "Delete workspace managed worktree failed."
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
      request,
      requestOptions
    ) {
      return unwrapData(
        await updateWorkspaceAgentSessionSettings({
          client,
          body: request,
          path: { agentSessionID, workspaceID },
          ...agentCommandRequestOptions(requestOptions)
        }),
        "Update workspace agent session settings failed."
      ).session;
    },
    async updateWorkspaceAgentSessionPin(
      workspaceID,
      agentSessionID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await updateWorkspaceAgentSessionPin({
          client,
          body: request,
          path: { agentSessionID, workspaceID },
          ...requestOptions
        }),
        "Update workspace agent session pin failed."
      ).session;
    },
    async updateWorkspaceAgentSessionTitle(
      workspaceID,
      agentSessionID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await updateWorkspaceAgentSessionTitle({
          client,
          body: request,
          path: { agentSessionID, workspaceID },
          ...requestOptions
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
      request,
      requestOptions
    ) {
      return unwrapData(
        await submitWorkspaceAgentInteractive({
          client,
          body: request,
          path: { agentSessionID, requestID, workspaceID },
          ...agentCommandRequestOptions(requestOptions)
        }),
        "Submit workspace agent interactive response failed."
      ).session;
    }
  };
}

function agentCommandRequestOptions(
  requestOptions: AgentCommandRequestOptions | undefined
) {
  const { agentCommandOrigin, ...fetchOptions } = requestOptions ?? {};
  return {
    ...fetchOptions,
    ...(agentCommandOrigin
      ? {
          headers: {
            "X-Tutti-Agent-Command-Origin": agentCommandOrigin
          }
        }
      : {})
  };
}
