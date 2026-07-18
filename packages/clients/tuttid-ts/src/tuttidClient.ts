import {
  authenticateAgentTargetRuntime,
  addWorkspaceIssueContextRefs,
  addWorkspaceIssueTaskContextRefs,
  cancelWorkspaceIssueExecution,
  checkUserProjectPath,
  completeWorkspaceIssueRun,
  completeWorkspaceIssueTaskRun,
  createWorkspaceIssue,
  createWorkspaceIssueRun,
  createWorkspaceIssueTask,
  createWorkspaceIssueTasks,
  createWorkspaceIssueTaskRun,
  createWorkspaceIssueTopic,
  createWorkspace,
  createAgentQuickPrompt,
  createWorkspaceFile,
  createWorkspaceFileDirectory,
  createWorkspaceTerminal,
  deleteUserProject,
  deleteAgentQuickPrompt,
  deleteWorkspaceIssue,
  deleteWorkspaceIssueTask,
  deleteWorkspaceIssueTopic,
  deleteWorkspace,
  deleteWorkspaceFileEntry,
  getDesktopPreferences,
  getAccountLoginStatus,
  getAccountProductSummary,
  getAccountUserInfo,
  dismissAccountRegistrationCreditsReward,
  getHealth,
  getAgentTargetSetup,
  getStartupWorkspace,
  listAgentTargets,
  listAgentQuickPrompts,
  getWorkspaceFileTreeSnapshot,
  getWorkspace,
  getWorkspaceIssueDetail,
  getWorkspaceIssueRun,
  getWorkspaceIssueTaskDetail,
  getWorkspaceIssueTaskRun,
  getWorkspaceTerminal,
  getWorkspaceTerminalSnapshot,
  getWorkspaceWorkbench,
  listCliCapabilities,
  listWorkspaceAppMentionCandidates,
  listUserProjects,
  moveUserProject,
  moveAgentQuickPrompt,
  pinUserProject,
  listWorkspaceIssues,
  listWorkspaceIssueTopics,
  listWorkspaceIssueRuns,
  listWorkspaceIssueTaskRuns,
  listWorkspaceIssueTasks,
  listWorkspaceTerminals,
  listWorkspaceFileDirectory,
  listWorkspaceRecentFiles,
  listWorkspaces,
  installAgentTargetRuntime,
  logoutAccount,
  copyWorkspaceFileEntry,
  moveWorkspaceFileEntry,
  renameWorkspaceFileEntry,
  openWorkspace,
  preflightUploadWorkspaceFiles,
  putDesktopPreferences,
  purgeDeletedAgentConversations,
  putWorkspaceWorkbench,
  checkWorkspaceTerminalCloseGuard,
  readWorkspaceFilePreview,
  removeWorkspaceIssueContextRef,
  removeWorkspaceIssueTaskContextRef,
  resizeWorkspaceTerminal,
  searchWorkspaceFiles,
  searchWorkspaceIssueReferences,
  setSystemAgentTargetEnabled,
  startAccountLogin,
  terminateWorkspaceTerminal,
  trackEvents,
  updateWorkspaceIssue,
  updateWorkspaceIssueTask,
  updateWorkspaceIssueTopic,
  updateAgentQuickPrompt,
  updateWorkspace,
  uploadWorkspaceFiles,
  useUserProject,
  writeWorkspaceFileText
} from "./generated/index.ts";
import { createClient } from "./generated/client/index.ts";
import { createAgentProvidersClient } from "./agentProvidersClient.ts";
import { unwrapAccepted, unwrapData } from "./tuttidClientResponse.ts";
import { createWorkspaceAppsClient } from "./workspaceAppsClient.ts";
import { createWorkspaceAgentClient } from "./workspaceAgentClient.ts";
import { createWorkspaceAgentConfigurationClient } from "./workspaceAgentConfigurationClient.ts";
import { createTuttiModeActivationClient } from "./tuttiModeActivationClient.ts";
import { createWorkspaceWorkflowClient } from "./workspaceWorkflowClient.ts";
import type {
  CreateTuttidClientInput,
  TuttidClient
} from "./tuttidClientTypes.ts";

export type {
  CreateTuttidClientInput,
  TuttidClient,
  TuttidRequestOptions,
  TuttidTrackEvent,
  TuttidTrackEventsRequest
} from "./tuttidClientTypes.ts";

const defaultBaseUrl = "http://tuttid.local";

export function createTuttidClient(
  input: CreateTuttidClientInput
): TuttidClient {
  const client = createClient({
    auth: input.auth,
    baseUrl: input.baseUrl ?? defaultBaseUrl,
    fetch: input.fetch
  });

  return {
    ...createWorkspaceAgentConfigurationClient(client),
    async listAgentQuickPrompts() {
      return unwrapData(
        await listAgentQuickPrompts({ client }),
        "Agent quick prompts request failed."
      );
    },
    async createAgentQuickPrompt(request) {
      return unwrapData(
        await createAgentQuickPrompt({ client, body: request }),
        "Create Agent quick prompt request failed."
      ).prompt;
    },
    async updateAgentQuickPrompt(promptID, request) {
      return unwrapData(
        await updateAgentQuickPrompt({
          client,
          body: request,
          path: { promptId: promptID }
        }),
        "Update Agent quick prompt request failed."
      ).prompt;
    },
    async deleteAgentQuickPrompt(promptID, request) {
      const response = await deleteAgentQuickPrompt({
        client,
        body: request,
        path: { promptId: promptID }
      });
      unwrapAccepted(response, "Delete Agent quick prompt request failed.");
    },
    async moveAgentQuickPrompt(request) {
      return unwrapData(
        await moveAgentQuickPrompt({ client, body: request }),
        "Move Agent quick prompt request failed."
      );
    },
    async listAgentTargets() {
      return unwrapData(
        await listAgentTargets({ client }),
        "Agent targets request failed."
      );
    },
    async setSystemAgentTargetEnabled(agentTargetID, enabled) {
      return unwrapData(
        await setSystemAgentTargetEnabled({
          client,
          body: { enabled },
          path: { agentTargetID }
        }),
        "Agent target visibility update failed."
      );
    },
    async getAgentTargetSetup(workspaceID, agentTargetID) {
      return unwrapData(
        await getAgentTargetSetup({
          client,
          path: { workspaceID, agentTargetID }
        }),
        "Agent target setup request failed."
      );
    },
    async installAgentTargetRuntime(workspaceID, agentTargetID, request) {
      return unwrapData(
        await installAgentTargetRuntime({
          client,
          path: { workspaceID, agentTargetID },
          body: request
        }),
        "Agent target runtime install request failed."
      );
    },
    async authenticateAgentTargetRuntime(workspaceID, agentTargetID, request) {
      return unwrapData(
        await authenticateAgentTargetRuntime({
          client,
          path: { workspaceID, agentTargetID },
          body: request
        }),
        "Agent target runtime authentication request failed."
      );
    },
    async startAccountLogin() {
      const response = await startAccountLogin({ client });
      return unwrapData(response, "Start account login request failed.");
    },
    async getAccountLoginStatus(attemptID) {
      const response = await getAccountLoginStatus({
        client,
        query: { attempt_id: attemptID }
      });
      return unwrapData(response, "Account login status request failed.");
    },
    async getAccountUserInfo() {
      const response = await getAccountUserInfo({ client });
      return unwrapData(response, "Account user info request failed.").user;
    },
    async getAccountProductSummary() {
      const response = await getAccountProductSummary({ client });
      return unwrapData(response, "Account product summary request failed.");
    },
    async dismissAccountRegistrationCreditsReward(rewardID) {
      const response = await dismissAccountRegistrationCreditsReward({
        client,
        body: { reward_id: rewardID }
      });
      unwrapAccepted(
        response,
        "Dismiss account registration credits reward request failed."
      );
    },
    async logoutAccount() {
      const response = await logoutAccount({ client });
      unwrapAccepted(response, "Account logout request failed.");
    },
    async listCliCapabilities(workspaceID, options) {
      const response = await listCliCapabilities({
        client,
        query: {
          ...(workspaceID ? { workspaceID } : {}),
          ...(options?.includeHidden ? { includeHidden: true } : {}),
          ...(options?.includeIntegration ? { includeIntegration: true } : {})
        }
      });
      return unwrapData(response, "CLI capabilities request failed.");
    },
    async listWorkspaceAppMentionCandidates(workspaceID) {
      const response = await listWorkspaceAppMentionCandidates({
        client,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Workspace app mention candidates request failed."
      );
    },
    async addWorkspaceIssueContextRefs(workspaceID, issueID, request) {
      const response = await addWorkspaceIssueContextRefs({
        client,
        body: request,
        path: { issueID, workspaceID }
      });
      return unwrapData(
        response,
        "Add workspace issue context refs request failed."
      );
    },
    async addWorkspaceIssueTaskContextRefs(
      workspaceID,
      issueID,
      taskID,
      request
    ) {
      const response = await addWorkspaceIssueTaskContextRefs({
        client,
        body: request,
        path: { issueID, taskID, workspaceID }
      });
      return unwrapData(
        response,
        "Add workspace issue task context refs request failed."
      );
    },
    async completeWorkspaceIssueTaskRun(
      workspaceID,
      issueID,
      taskID,
      runID,
      request
    ) {
      const response = await completeWorkspaceIssueTaskRun({
        client,
        body: request,
        path: { issueID, runID, taskID, workspaceID }
      });
      return unwrapData(
        response,
        "Complete workspace issue task run request failed."
      );
    },
    async completeWorkspaceIssueRun(workspaceID, issueID, runID, request) {
      const response = await completeWorkspaceIssueRun({
        client,
        body: request,
        path: { issueID, runID, workspaceID }
      });
      return unwrapData(
        response,
        "Complete workspace issue run request failed."
      );
    },
    async createWorkspaceIssue(workspaceID, request) {
      const response = await createWorkspaceIssue({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(response, "Create workspace issue request failed.")
        .issue;
    },
    async createWorkspaceIssueTopic(workspaceID, request) {
      const response = await createWorkspaceIssueTopic({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Create workspace issue topic request failed."
      ).topic;
    },
    async createWorkspaceIssueTask(workspaceID, issueID, request) {
      const response = await createWorkspaceIssueTask({
        client,
        body: request,
        path: { issueID, workspaceID }
      });
      return unwrapData(response, "Create workspace issue task request failed.")
        .task;
    },
    async createWorkspaceIssueTasks(workspaceID, issueID, request) {
      const response = await createWorkspaceIssueTasks({
        client,
        body: request,
        path: { issueID, workspaceID }
      });
      return unwrapData(
        response,
        "Create workspace issue tasks request failed."
      ).tasks;
    },
    async createWorkspaceIssueTaskRun(workspaceID, issueID, taskID, request) {
      const response = await createWorkspaceIssueTaskRun({
        client,
        body: request,
        path: { issueID, taskID, workspaceID }
      });
      return unwrapData(
        response,
        "Create workspace issue task run request failed."
      ).run;
    },
    async createWorkspaceIssueRun(workspaceID, issueID, request) {
      const response = await createWorkspaceIssueRun({
        client,
        body: request,
        path: { issueID, workspaceID }
      });
      return unwrapData(response, "Create workspace issue run request failed.")
        .run;
    },
    async createWorkspaceFile(workspaceID, path) {
      const response = await createWorkspaceFile({
        client,
        body: { path },
        path: { workspaceID }
      });
      return unwrapData(response, "Create workspace file request failed.");
    },
    async readWorkspaceFilePreview(workspaceID, path) {
      const response = await readWorkspaceFilePreview({
        client,
        path: { workspaceID },
        query: { path }
      });
      return unwrapData(
        response,
        "Read workspace file preview request failed."
      );
    },
    async writeWorkspaceFileText(workspaceID, request) {
      const response = await writeWorkspaceFileText({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(response, "Write workspace file text request failed.");
    },
    async createWorkspaceFileDirectory(workspaceID, path) {
      const response = await createWorkspaceFileDirectory({
        client,
        body: { path },
        path: { workspaceID }
      });
      return unwrapData(response, "Create workspace directory request failed.");
    },
    async createWorkspace(request) {
      const response = await createWorkspace({
        client,
        body: request
      });
      return unwrapData(response, "Create workspace request failed.").workspace;
    },
    async createWorkspaceTerminal(workspaceID, request = {}) {
      const response = await createWorkspaceTerminal({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(response, "Create workspace terminal request failed.")
        .terminal;
    },
    async deleteWorkspaceIssue(workspaceID, issueID) {
      const response = await deleteWorkspaceIssue({
        client,
        path: { issueID, workspaceID }
      });
      return unwrapData(response, "Delete workspace issue request failed.");
    },
    async deleteWorkspaceIssueTask(workspaceID, issueID, taskID) {
      const response = await deleteWorkspaceIssueTask({
        client,
        path: { issueID, taskID, workspaceID }
      });
      return unwrapData(
        response,
        "Delete workspace issue task request failed."
      );
    },
    async deleteWorkspaceIssueTopic(workspaceID, topicID) {
      const response = await deleteWorkspaceIssueTopic({
        client,
        path: { topicID, workspaceID }
      });
      return unwrapData(
        response,
        "Delete workspace issue topic request failed."
      );
    },
    async deleteWorkspace(workspaceID) {
      const response = await deleteWorkspace({
        client,
        path: { workspaceID }
      });
      return unwrapData(response, "Delete workspace request failed.");
    },
    async deleteWorkspaceFileEntry(workspaceID, request) {
      const response = await deleteWorkspaceFileEntry({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Delete workspace file entry request failed."
      );
    },
    async moveWorkspaceFileEntry(workspaceID, request) {
      const response = await moveWorkspaceFileEntry({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(response, "Move workspace file entry request failed.");
    },
    async renameWorkspaceFileEntry(workspaceID, request) {
      const response = await renameWorkspaceFileEntry({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Rename workspace file entry request failed."
      );
    },
    async copyWorkspaceFileEntry(workspaceID, request) {
      const response = await copyWorkspaceFileEntry({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(response, "Copy workspace file entry request failed.");
    },
    async getDesktopPreferences() {
      return unwrapData(
        await getDesktopPreferences({ client }),
        "Desktop preferences request failed."
      );
    },
    async purgeDeletedAgentConversations() {
      return unwrapData(
        await purgeDeletedAgentConversations({ client }),
        "Deleted Agent conversation purge request failed."
      );
    },
    async getHealth() {
      return unwrapData(
        await getHealth({ client }),
        "Runtime health request failed."
      );
    },
    async getStartupWorkspace() {
      return unwrapData(
        await getStartupWorkspace({ client }),
        "Startup workspace request failed."
      ).workspace;
    },
    async getWorkspace(workspaceID) {
      const response = await getWorkspace({
        client,
        path: { workspaceID }
      });
      return unwrapData(response, "Workspace request failed.").workspace;
    },
    async getWorkspaceIssueDetail(workspaceID, issueID) {
      const response = await getWorkspaceIssueDetail({
        client,
        path: { issueID, workspaceID }
      });
      return unwrapData(response, "Workspace issue detail request failed.");
    },
    async searchWorkspaceIssueReferences(workspaceID, request) {
      const response = await searchWorkspaceIssueReferences({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Workspace issue reference search request failed."
      );
    },
    async getWorkspaceIssueTaskDetail(workspaceID, issueID, taskID) {
      const response = await getWorkspaceIssueTaskDetail({
        client,
        path: { issueID, taskID, workspaceID }
      });
      return unwrapData(
        response,
        "Workspace issue task detail request failed."
      );
    },
    async getWorkspaceIssueTaskRun(workspaceID, issueID, taskID, runID) {
      const response = await getWorkspaceIssueTaskRun({
        client,
        path: { issueID, runID, taskID, workspaceID }
      });
      return unwrapData(response, "Workspace issue task run request failed.");
    },
    async getWorkspaceIssueRun(workspaceID, issueID, runID) {
      const response = await getWorkspaceIssueRun({
        client,
        path: { issueID, runID, workspaceID }
      });
      return unwrapData(response, "Workspace issue run request failed.");
    },
    async getWorkspaceTerminal(workspaceID, terminalID) {
      const response = await getWorkspaceTerminal({
        client,
        path: { terminalID, workspaceID }
      });
      return unwrapData(response, "Workspace terminal request failed.")
        .terminal;
    },
    async getWorkspaceTerminalSnapshot(workspaceID, terminalID) {
      const response = await getWorkspaceTerminalSnapshot({
        client,
        path: { terminalID, workspaceID }
      });
      return unwrapData(response, "Workspace terminal snapshot request failed.")
        .snapshot;
    },
    async getWorkspaceWorkbench(workspaceID) {
      const response = await getWorkspaceWorkbench({
        client,
        path: { workspaceID }
      });
      return unwrapData(response, "Workspace workbench request failed.")
        .snapshot;
    },
    async listWorkspaceIssues(workspaceID, request, requestOptions) {
      const response = await listWorkspaceIssues({
        client,
        path: { workspaceID },
        query: request,
        ...requestOptions
      });
      return unwrapData(response, "Workspace issues request failed.");
    },
    async listWorkspaceIssueTopics(workspaceID, requestOptions) {
      const response = await listWorkspaceIssueTopics({
        client,
        path: { workspaceID },
        ...requestOptions
      });
      return unwrapData(response, "Workspace issue topics request failed.");
    },
    async listWorkspaceIssueTaskRuns(workspaceID, issueID, taskID) {
      const response = await listWorkspaceIssueTaskRuns({
        client,
        path: { issueID, taskID, workspaceID }
      });
      return unwrapData(response, "Workspace issue task runs request failed.");
    },
    async listWorkspaceIssueRuns(workspaceID, issueID) {
      const response = await listWorkspaceIssueRuns({
        client,
        path: { issueID, workspaceID }
      });
      return unwrapData(response, "Workspace issue runs request failed.");
    },
    async listWorkspaceIssueTasks(workspaceID, issueID, request) {
      const response = await listWorkspaceIssueTasks({
        client,
        path: { issueID, workspaceID },
        query: request
      });
      return unwrapData(response, "Workspace issue tasks request failed.");
    },
    async listWorkspaceTerminals(workspaceID) {
      const response = await listWorkspaceTerminals({
        client,
        path: { workspaceID }
      });
      return unwrapData(response, "Workspace terminals request failed.");
    },
    async listWorkspaceFileDirectory(workspaceID, request) {
      const response = await listWorkspaceFileDirectory({
        client,
        path: { workspaceID },
        query: request
      });
      return unwrapData(response, "Workspace file directory request failed.");
    },
    async listWorkspaceRecentFiles(workspaceID, request, requestOptions) {
      const response = await listWorkspaceRecentFiles({
        client,
        path: { workspaceID },
        query: request,
        ...requestOptions
      });
      return unwrapData(response, "Workspace recent files request failed.");
    },
    async getWorkspaceFileTreeSnapshot(workspaceID, request) {
      const response = await getWorkspaceFileTreeSnapshot({
        client,
        path: { workspaceID },
        query: request
      });
      return unwrapData(
        response,
        "Workspace file tree snapshot request failed."
      );
    },
    async listWorkspaces() {
      return unwrapData(
        await listWorkspaces({ client }),
        "Workspace request failed."
      );
    },
    async checkUserProjectPath(request) {
      const response = await checkUserProjectPath({
        client,
        body: request
      });
      return unwrapData(response, "Check user project path failed.");
    },
    async listUserProjects() {
      const response = await listUserProjects({ client });
      return unwrapData(response, "List user projects failed.");
    },
    async moveUserProject(request) {
      const response = await moveUserProject({
        client,
        body: request
      });
      return unwrapData(response, "Move user project failed.");
    },
    async pinUserProject(request) {
      const response = await pinUserProject({
        client,
        body: request
      });
      return unwrapData(response, "Pin user project failed.");
    },
    async deleteUserProject(request) {
      const response = await deleteUserProject({
        client,
        body: request
      });
      unwrapAccepted(response, "Delete user project failed.");
    },
    async openWorkspace(workspaceID) {
      const response = await openWorkspace({
        client,
        path: { workspaceID }
      });
      return unwrapData(response, "Open workspace request failed.").workspace;
    },
    async removeWorkspaceIssueContextRef(workspaceID, issueID, contextRefID) {
      const response = await removeWorkspaceIssueContextRef({
        client,
        path: { contextRefID, issueID, workspaceID }
      });
      return unwrapData(
        response,
        "Remove workspace issue context ref request failed."
      );
    },
    async removeWorkspaceIssueTaskContextRef(
      workspaceID,
      issueID,
      taskID,
      contextRefID
    ) {
      const response = await removeWorkspaceIssueTaskContextRef({
        client,
        path: { contextRefID, issueID, taskID, workspaceID }
      });
      return unwrapData(
        response,
        "Remove workspace issue task context ref request failed."
      );
    },
    async updateWorkspace(workspaceID, request) {
      const response = await updateWorkspace({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(response, "Update workspace request failed.").workspace;
    },
    async updateWorkspaceIssue(workspaceID, issueID, request) {
      const response = await updateWorkspaceIssue({
        client,
        body: request,
        path: { issueID, workspaceID }
      });
      return unwrapData(response, "Update workspace issue request failed.")
        .issue;
    },
    async updateWorkspaceIssueTopic(workspaceID, topicID, request) {
      const response = await updateWorkspaceIssueTopic({
        client,
        body: request,
        path: { topicID, workspaceID }
      });
      return unwrapData(
        response,
        "Update workspace issue topic request failed."
      ).topic;
    },
    async updateWorkspaceIssueTask(workspaceID, issueID, taskID, request) {
      const response = await updateWorkspaceIssueTask({
        client,
        body: request,
        path: { issueID, taskID, workspaceID }
      });
      return unwrapData(response, "Update workspace issue task request failed.")
        .task;
    },
    async cancelWorkspaceIssueExecution(workspaceID, issueID) {
      const response = await cancelWorkspaceIssueExecution({
        client,
        path: { issueID, workspaceID }
      });
      return unwrapData(
        response,
        "Cancel workspace issue execution request failed."
      );
    },
    async putWorkspaceWorkbench(workspaceID, snapshot) {
      const response = await putWorkspaceWorkbench({
        client,
        body: { snapshot },
        path: { workspaceID }
      });
      return unwrapData(response, "Persist workspace workbench request failed.")
        .snapshot;
    },
    async checkWorkspaceTerminalCloseGuard(workspaceID, terminalID) {
      const response = await checkWorkspaceTerminalCloseGuard({
        client,
        path: { terminalID, workspaceID }
      });
      return unwrapData(
        response,
        "Workspace terminal close guard request failed."
      ).guard;
    },
    async resizeWorkspaceTerminal(workspaceID, terminalID, request) {
      const response = await resizeWorkspaceTerminal({
        client,
        body: request,
        path: { terminalID, workspaceID }
      });
      return unwrapData(response, "Resize workspace terminal request failed.")
        .terminal;
    },
    async searchWorkspaceFiles(workspaceID, request, requestOptions) {
      const response = await searchWorkspaceFiles({
        client,
        path: { workspaceID },
        query: request,
        ...requestOptions
      });
      return unwrapData(response, "Workspace file search request failed.");
    },
    async preflightUploadWorkspaceFiles(workspaceID, request) {
      const response = await preflightUploadWorkspaceFiles({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Workspace file upload preflight request failed."
      );
    },
    async putDesktopPreferences(request) {
      return unwrapData(
        await putDesktopPreferences({
          client,
          body: request
        }),
        "Persist desktop preferences request failed."
      );
    },
    async uploadWorkspaceFiles(workspaceID, request) {
      const response = await uploadWorkspaceFiles({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(response, "Workspace file upload request failed.");
    },
    async terminateWorkspaceTerminal(workspaceID, terminalID) {
      const response = await terminateWorkspaceTerminal({
        client,
        path: { terminalID, workspaceID }
      });
      return unwrapData(
        response,
        "Terminate workspace terminal request failed."
      ).terminal;
    },
    async trackEvents(events) {
      const response = await trackEvents({
        client,
        body: { events }
      });
      unwrapAccepted(response, "Track analytics events request failed.");
    },
    async useUserProject(request) {
      const response = await useUserProject({
        client,
        body: request
      });
      return unwrapData(response, "Record user project usage failed.").project;
    },
    ...createAgentProvidersClient(client),
    ...createWorkspaceAgentClient(client),
    ...createWorkspaceAppsClient(client),
    ...createTuttiModeActivationClient(client),
    ...createWorkspaceWorkflowClient(client)
  };
}
