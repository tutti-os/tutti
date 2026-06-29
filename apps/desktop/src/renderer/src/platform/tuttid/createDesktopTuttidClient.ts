import {
  createTuttidClient,
  type TuttidClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";

export function createDesktopTuttidClient(
  runtimeApi: DesktopRuntimeApi
): TuttidClient {
  let clientPromise: Promise<TuttidClient> | null = null;

  const resolveClient = async (): Promise<TuttidClient> => {
    clientPromise ??= runtimeApi.getBackendConfig().then((config) =>
      createTuttidClient({
        auth: config.accessToken,
        baseUrl: config.baseUrl,
        fetch: globalThis.fetch.bind(globalThis)
      })
    );

    return clientPromise;
  };

  return {
    async listCliCapabilities(workspaceID, options) {
      return (await resolveClient()).listCliCapabilities(workspaceID, options);
    },
    async listWorkspaceAppMentionCandidates(workspaceID) {
      return (await resolveClient()).listWorkspaceAppMentionCandidates(
        workspaceID
      );
    },
    async addWorkspaceIssueContextRefs(workspaceID, issueID, request) {
      return (await resolveClient()).addWorkspaceIssueContextRefs(
        workspaceID,
        issueID,
        request
      );
    },
    async addWorkspaceIssueTaskContextRefs(
      workspaceID,
      issueID,
      taskID,
      request
    ) {
      return (await resolveClient()).addWorkspaceIssueTaskContextRefs(
        workspaceID,
        issueID,
        taskID,
        request
      );
    },
    async installWorkspaceApp(workspaceID, appID, request) {
      return (await resolveClient()).installWorkspaceApp(
        workspaceID,
        appID,
        request
      );
    },
    async exportWorkspaceApp(workspaceID, appID, request) {
      return (await resolveClient()).exportWorkspaceApp(
        workspaceID,
        appID,
        request
      );
    },
    async importWorkspaceApp(workspaceID, request) {
      return (await resolveClient()).importWorkspaceApp(workspaceID, request);
    },
    async loadLocalWorkspaceApp(workspaceID, request) {
      return (await resolveClient()).loadLocalWorkspaceApp(
        workspaceID,
        request
      );
    },
    async replaceWorkspaceAppIcon(workspaceID, appID, request) {
      return (await resolveClient()).replaceWorkspaceAppIcon(
        workspaceID,
        appID,
        request
      );
    },
    async reloadLocalWorkspaceApp(workspaceID, appID, request) {
      return (await resolveClient()).reloadLocalWorkspaceApp(
        workspaceID,
        appID,
        request
      );
    },
    async completeWorkspaceIssueTaskRun(
      workspaceID,
      issueID,
      taskID,
      runID,
      request
    ) {
      return (await resolveClient()).completeWorkspaceIssueTaskRun(
        workspaceID,
        issueID,
        taskID,
        runID,
        request
      );
    },
    async completeWorkspaceIssueRun(workspaceID, issueID, runID, request) {
      return (await resolveClient()).completeWorkspaceIssueRun(
        workspaceID,
        issueID,
        runID,
        request
      );
    },
    async createWorkspaceIssue(workspaceID, request) {
      return (await resolveClient()).createWorkspaceIssue(workspaceID, request);
    },
    async createWorkspaceIssueTopic(workspaceID, request) {
      return (await resolveClient()).createWorkspaceIssueTopic(
        workspaceID,
        request
      );
    },
    async createWorkspaceIssueTask(workspaceID, issueID, request) {
      return (await resolveClient()).createWorkspaceIssueTask(
        workspaceID,
        issueID,
        request
      );
    },
    async createWorkspaceIssueRun(workspaceID, issueID, request) {
      return (await resolveClient()).createWorkspaceIssueRun(
        workspaceID,
        issueID,
        request
      );
    },
    async createWorkspaceIssueTaskRun(workspaceID, issueID, taskID, request) {
      return (await resolveClient()).createWorkspaceIssueTaskRun(
        workspaceID,
        issueID,
        taskID,
        request
      );
    },
    async createWorkspace(request) {
      return (await resolveClient()).createWorkspace(request);
    },
    async createWorkspaceAgentSession(workspaceID, request, requestOptions) {
      return (await resolveClient()).createWorkspaceAgentSession(
        workspaceID,
        request,
        requestOptions
      );
    },
    async updateWorkspaceAgentSessionVisibility(
      workspaceID,
      agentSessionID,
      request
    ) {
      return (await resolveClient()).updateWorkspaceAgentSessionVisibility(
        workspaceID,
        agentSessionID,
        request
      );
    },
    async createWorkspaceTerminal(workspaceID, request) {
      return (await resolveClient()).createWorkspaceTerminal(
        workspaceID,
        request
      );
    },
    async createWorkspaceFile(workspaceID, path) {
      return (await resolveClient()).createWorkspaceFile(workspaceID, path);
    },
    async readWorkspaceFilePreview(workspaceID, path) {
      return (await resolveClient()).readWorkspaceFilePreview(
        workspaceID,
        path
      );
    },
    async writeWorkspaceFileText(workspaceID, request) {
      return (await resolveClient()).writeWorkspaceFileText(
        workspaceID,
        request
      );
    },
    async createWorkspaceFileDirectory(workspaceID, path) {
      return (await resolveClient()).createWorkspaceFileDirectory(
        workspaceID,
        path
      );
    },
    async deleteWorkspace(workspaceID) {
      return (await resolveClient()).deleteWorkspace(workspaceID);
    },
    async deleteWorkspaceIssue(workspaceID, issueID) {
      return (await resolveClient()).deleteWorkspaceIssue(workspaceID, issueID);
    },
    async deleteWorkspaceIssueTopic(workspaceID, topicID) {
      return (await resolveClient()).deleteWorkspaceIssueTopic(
        workspaceID,
        topicID
      );
    },
    async deleteWorkspaceIssueTask(workspaceID, issueID, taskID) {
      return (await resolveClient()).deleteWorkspaceIssueTask(
        workspaceID,
        issueID,
        taskID
      );
    },
    async deleteWorkspaceFileEntry(workspaceID, request) {
      return (await resolveClient()).deleteWorkspaceFileEntry(
        workspaceID,
        request
      );
    },
    async listWorkspaceApps(workspaceID) {
      return (await resolveClient()).listWorkspaceApps(workspaceID);
    },
    async listWorkspaceAppReferences(workspaceID, appID, request) {
      return (await resolveClient()).listWorkspaceAppReferences(
        workspaceID,
        appID,
        request
      );
    },
    async searchWorkspaceAppReferences(workspaceID, appID, request) {
      return (await resolveClient()).searchWorkspaceAppReferences(
        workspaceID,
        appID,
        request
      );
    },
    async prepareWorkspaceAppUpload(workspaceID, appID, request) {
      return (await resolveClient()).prepareWorkspaceAppUpload(
        workspaceID,
        appID,
        request
      );
    },
    async completeWorkspaceAppUpload(workspaceID, appID, uploadID) {
      return (await resolveClient()).completeWorkspaceAppUpload(
        workspaceID,
        appID,
        uploadID
      );
    },
    async cancelWorkspaceAppUpload(workspaceID, appID, uploadID) {
      return (await resolveClient()).cancelWorkspaceAppUpload(
        workspaceID,
        appID,
        uploadID
      );
    },
    async refreshWorkspaceAppCatalog(workspaceID) {
      return (await resolveClient()).refreshWorkspaceAppCatalog(workspaceID);
    },
    async listWorkspaceAppFactoryJobs(workspaceID) {
      return (await resolveClient()).listWorkspaceAppFactoryJobs(workspaceID);
    },
    async deleteWorkspaceAppFactoryJob(workspaceID, jobID) {
      return (await resolveClient()).deleteWorkspaceAppFactoryJob(
        workspaceID,
        jobID
      );
    },
    async deleteWorkspaceAgentSession(workspaceID, agentSessionID) {
      return (await resolveClient()).deleteWorkspaceAgentSession(
        workspaceID,
        agentSessionID
      );
    },
    async clearWorkspaceAgentSessions(workspaceID) {
      return (await resolveClient()).clearWorkspaceAgentSessions(workspaceID);
    },
    async moveWorkspaceFileEntry(workspaceID, request) {
      return (await resolveClient()).moveWorkspaceFileEntry(
        workspaceID,
        request
      );
    },
    async renameWorkspaceFileEntry(workspaceID, request) {
      return (await resolveClient()).renameWorkspaceFileEntry(
        workspaceID,
        request
      );
    },
    async copyWorkspaceFileEntry(workspaceID, request) {
      return (await resolveClient()).copyWorkspaceFileEntry(
        workspaceID,
        request
      );
    },
    async getDesktopPreferences() {
      return (await resolveClient()).getDesktopPreferences();
    },
    async getHealth() {
      return (await resolveClient()).getHealth();
    },
    async getStartupWorkspace() {
      return (await resolveClient()).getStartupWorkspace();
    },
    async getWorkspace(workspaceID) {
      return (await resolveClient()).getWorkspace(workspaceID);
    },
    async getWorkspaceAgentSession(workspaceID, agentSessionID) {
      return (await resolveClient()).getWorkspaceAgentSession(
        workspaceID,
        agentSessionID
      );
    },
    async getWorkspaceAppFactoryProviderComposerOptions(
      workspaceID,
      provider,
      request
    ) {
      return (
        await resolveClient()
      ).getWorkspaceAppFactoryProviderComposerOptions(
        workspaceID,
        provider,
        request
      );
    },
    async getAgentProviderComposerOptions(provider, request, requestOptions) {
      return (await resolveClient()).getAgentProviderComposerOptions(
        provider,
        request,
        requestOptions
      );
    },
    async getAgentProviderStatuses(request) {
      return (await resolveClient()).getAgentProviderStatuses(request);
    },
    async probeAgentProvider(provider) {
      return (await resolveClient()).probeAgentProvider(provider);
    },
    async runAgentProviderAction(provider, actionID) {
      return (await resolveClient()).runAgentProviderAction(provider, actionID);
    },
    async getWorkspaceIssueDetail(workspaceID, issueID) {
      return (await resolveClient()).getWorkspaceIssueDetail(
        workspaceID,
        issueID
      );
    },
    async searchWorkspaceIssueReferences(workspaceID, request) {
      return (await resolveClient()).searchWorkspaceIssueReferences(
        workspaceID,
        request
      );
    },
    async getWorkspaceIssueTaskDetail(workspaceID, issueID, taskID) {
      return (await resolveClient()).getWorkspaceIssueTaskDetail(
        workspaceID,
        issueID,
        taskID
      );
    },
    async getWorkspaceIssueTaskRun(workspaceID, issueID, taskID, runID) {
      return (await resolveClient()).getWorkspaceIssueTaskRun(
        workspaceID,
        issueID,
        taskID,
        runID
      );
    },
    async getWorkspaceIssueRun(workspaceID, issueID, runID) {
      return (await resolveClient()).getWorkspaceIssueRun(
        workspaceID,
        issueID,
        runID
      );
    },
    async getWorkspaceTerminal(workspaceID, terminalID) {
      return (await resolveClient()).getWorkspaceTerminal(
        workspaceID,
        terminalID
      );
    },
    async getWorkspaceTerminalSnapshot(workspaceID, terminalID) {
      return (await resolveClient()).getWorkspaceTerminalSnapshot(
        workspaceID,
        terminalID
      );
    },
    async getWorkspaceWorkbench(workspaceID) {
      return (await resolveClient()).getWorkspaceWorkbench(workspaceID);
    },
    async listWorkspaceAgentSessionMessages(
      workspaceID,
      agentSessionID,
      request
    ) {
      return (await resolveClient()).listWorkspaceAgentSessionMessages(
        workspaceID,
        agentSessionID,
        request
      );
    },
    async listWorkspaceAgentGeneratedFiles(workspaceID, request) {
      return (await resolveClient()).listWorkspaceAgentGeneratedFiles(
        workspaceID,
        request
      );
    },
    async listUserProjects() {
      return (await resolveClient()).listUserProjects();
    },
    async deleteUserProject(request) {
      return (await resolveClient()).deleteUserProject(request);
    },
    async checkUserProjectPath(request) {
      return (await resolveClient()).checkUserProjectPath(request);
    },
    async listWorkspaceIssues(workspaceID, request) {
      return (await resolveClient()).listWorkspaceIssues(workspaceID, request);
    },
    async listWorkspaceIssueTopics(workspaceID) {
      return (await resolveClient()).listWorkspaceIssueTopics(workspaceID);
    },
    async listWorkspaceIssueTaskRuns(workspaceID, issueID, taskID) {
      return (await resolveClient()).listWorkspaceIssueTaskRuns(
        workspaceID,
        issueID,
        taskID
      );
    },
    async listWorkspaceIssueRuns(workspaceID, issueID) {
      return (await resolveClient()).listWorkspaceIssueRuns(
        workspaceID,
        issueID
      );
    },
    async listWorkspaceIssueTasks(workspaceID, issueID, request) {
      return (await resolveClient()).listWorkspaceIssueTasks(
        workspaceID,
        issueID,
        request
      );
    },
    async listWorkspaceFileDirectory(workspaceID, request) {
      return (await resolveClient()).listWorkspaceFileDirectory(
        workspaceID,
        request
      );
    },
    async listWorkspaceRecentFiles(workspaceID, request, requestOptions) {
      return (await resolveClient()).listWorkspaceRecentFiles(
        workspaceID,
        request,
        requestOptions
      );
    },
    async getWorkspaceFileTreeSnapshot(workspaceID, request) {
      return (await resolveClient()).getWorkspaceFileTreeSnapshot(
        workspaceID,
        request
      );
    },
    async listWorkspaces() {
      return (await resolveClient()).listWorkspaces();
    },
    async listWorkspaceTerminals(workspaceID) {
      return (await resolveClient()).listWorkspaceTerminals(workspaceID);
    },
    async listWorkspaceAgentSessions(workspaceID, request) {
      return (await resolveClient()).listWorkspaceAgentSessions(
        workspaceID,
        request
      );
    },
    async scanWorkspaceExternalAgentSessionImports(workspaceID, request) {
      return (await resolveClient()).scanWorkspaceExternalAgentSessionImports(
        workspaceID,
        request
      );
    },
    async importWorkspaceExternalAgentSessions(workspaceID, request) {
      return (await resolveClient()).importWorkspaceExternalAgentSessions(
        workspaceID,
        request
      );
    },
    async openWorkspace(workspaceID) {
      return (await resolveClient()).openWorkspace(workspaceID);
    },
    async removeWorkspaceIssueContextRef(workspaceID, issueID, contextRefID) {
      return (await resolveClient()).removeWorkspaceIssueContextRef(
        workspaceID,
        issueID,
        contextRefID
      );
    },
    async removeWorkspaceIssueTaskContextRef(
      workspaceID,
      issueID,
      taskID,
      contextRefID
    ) {
      return (await resolveClient()).removeWorkspaceIssueTaskContextRef(
        workspaceID,
        issueID,
        taskID,
        contextRefID
      );
    },
    async preflightUploadWorkspaceFiles(workspaceID, request) {
      return (await resolveClient()).preflightUploadWorkspaceFiles(
        workspaceID,
        request
      );
    },
    async putWorkspaceWorkbench(workspaceID, snapshot) {
      return (await resolveClient()).putWorkspaceWorkbench(
        workspaceID,
        snapshot
      );
    },
    async uninstallWorkspaceApp(workspaceID, appID) {
      return (await resolveClient()).uninstallWorkspaceApp(workspaceID, appID);
    },
    async deleteWorkspaceApp(workspaceID, appID) {
      return (await resolveClient()).deleteWorkspaceApp(workspaceID, appID);
    },
    async createWorkspaceAppFactoryJob(workspaceID, request) {
      return (await resolveClient()).createWorkspaceAppFactoryJob(
        workspaceID,
        request
      );
    },
    async getWorkspaceAppFactoryJob(workspaceID, jobID) {
      return (await resolveClient()).getWorkspaceAppFactoryJob(
        workspaceID,
        jobID
      );
    },
    async cancelWorkspaceAppFactoryJob(workspaceID, jobID) {
      return (await resolveClient()).cancelWorkspaceAppFactoryJob(
        workspaceID,
        jobID
      );
    },
    async retryWorkspaceAppFactoryJobValidation(workspaceID, jobID) {
      return (await resolveClient()).retryWorkspaceAppFactoryJobValidation(
        workspaceID,
        jobID
      );
    },
    async fixWorkspaceAppFactoryJob(workspaceID, jobID, request) {
      return (await resolveClient()).fixWorkspaceAppFactoryJob(
        workspaceID,
        jobID,
        request
      );
    },
    async prepareWorkspaceAppFactoryJobModification(workspaceID, jobID) {
      return (await resolveClient()).prepareWorkspaceAppFactoryJobModification(
        workspaceID,
        jobID
      );
    },
    async publishWorkspaceAppFactoryJob(workspaceID, jobID) {
      return (await resolveClient()).publishWorkspaceAppFactoryJob(
        workspaceID,
        jobID
      );
    },
    async checkWorkspaceTerminalCloseGuard(workspaceID, terminalID) {
      return (await resolveClient()).checkWorkspaceTerminalCloseGuard(
        workspaceID,
        terminalID
      );
    },
    async resizeWorkspaceTerminal(workspaceID, terminalID, request) {
      return (await resolveClient()).resizeWorkspaceTerminal(
        workspaceID,
        terminalID,
        request
      );
    },
    async cancelWorkspaceAgentSession(workspaceID, agentSessionID) {
      return (await resolveClient()).cancelWorkspaceAgentSession(
        workspaceID,
        agentSessionID
      );
    },
    async cancelWorkspaceAgentSessionWithResult(workspaceID, agentSessionID) {
      return (await resolveClient()).cancelWorkspaceAgentSessionWithResult(
        workspaceID,
        agentSessionID
      );
    },
    async sendWorkspaceAgentSessionInput(workspaceID, agentSessionID, request) {
      return (await resolveClient()).sendWorkspaceAgentSessionInput(
        workspaceID,
        agentSessionID,
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
    },
    async launchWorkspaceApp(workspaceID, appID) {
      return (await resolveClient()).launchWorkspaceApp(workspaceID, appID);
    },
    async retryWorkspaceApp(workspaceID, appID) {
      return (await resolveClient()).retryWorkspaceApp(workspaceID, appID);
    },
    async rollbackWorkspaceApp(workspaceID, appID, request) {
      return (await resolveClient()).rollbackWorkspaceApp(
        workspaceID,
        appID,
        request
      );
    },
    async searchWorkspaceFiles(workspaceID, request, requestOptions) {
      return (await resolveClient()).searchWorkspaceFiles(
        workspaceID,
        request,
        requestOptions
      );
    },
    async startEnabledWorkspaceApps(workspaceID) {
      return (await resolveClient()).startEnabledWorkspaceApps(workspaceID);
    },
    async stopAllWorkspaceApps(workspaceID) {
      return (await resolveClient()).stopAllWorkspaceApps(workspaceID);
    },
    async putDesktopPreferences(request) {
      return (await resolveClient()).putDesktopPreferences(request);
    },
    async updateWorkspaceIssue(workspaceID, issueID, request) {
      return (await resolveClient()).updateWorkspaceIssue(
        workspaceID,
        issueID,
        request
      );
    },
    async updateWorkspaceIssueTopic(workspaceID, topicID, request) {
      return (await resolveClient()).updateWorkspaceIssueTopic(
        workspaceID,
        topicID,
        request
      );
    },
    async updateWorkspaceIssueTask(workspaceID, issueID, taskID, request) {
      return (await resolveClient()).updateWorkspaceIssueTask(
        workspaceID,
        issueID,
        taskID,
        request
      );
    },
    async updateWorkspace(workspaceID, request) {
      return (await resolveClient()).updateWorkspace(workspaceID, request);
    },
    async uploadWorkspaceFiles(workspaceID, request) {
      return (await resolveClient()).uploadWorkspaceFiles(workspaceID, request);
    },
    async terminateWorkspaceTerminal(workspaceID, terminalID) {
      return (await resolveClient()).terminateWorkspaceTerminal(
        workspaceID,
        terminalID
      );
    },
    async trackEvents(events) {
      return (await resolveClient()).trackEvents(events);
    },
    async useUserProject(request) {
      return (await resolveClient()).useUserProject(request);
    }
  };
}
