import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceLaunch,
  type WorkspaceLaunchAdapters,
  type WorkspaceLaunchOwnerWindow
} from "./workspaceLaunch.ts";
import { createWorkspaceHostAccess } from "./workspaceHostAccess.ts";
import type { DesktopWorkspaceAppPayload } from "../../shared/contracts/ipc.ts";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";

function createAdapters(
  overrides: Partial<WorkspaceLaunchAdapters> = {}
): WorkspaceLaunchAdapters {
  return {
    async showAgentWindow() {},
    async showWorkspaceWindow() {},
    warnStartupWindowResolutionFailure() {},
    ...overrides
  };
}

function createTransportClient(
  overrides: Partial<TuttidClient> = {}
): TuttidClient {
  const client: TuttidClient = {
    async listAgentTargets() {
      throw new Error("not used");
    },
    async setSystemAgentTargetEnabled() {
      throw new Error("not used");
    },
    async getAgentTargetSetup() {
      throw new Error("not used");
    },
    async installAgentTargetRuntime() {
      throw new Error("not used");
    },
    async authenticateAgentTargetRuntime() {
      throw new Error("not used");
    },
    async startAccountLogin() {
      throw new Error("not used");
    },
    async getAccountLoginStatus() {
      throw new Error("not used");
    },
    async getAccountUserInfo() {
      throw new Error("not used");
    },
    async getAccountProductSummary() {
      throw new Error("not used");
    },
    async dismissAccountRegistrationCreditsReward() {
      throw new Error("not used");
    },
    async logoutAccount() {
      throw new Error("not used");
    },
    async applyWorkspaceGitPatch() {
      throw new Error("not used");
    },
    async listCliCapabilities() {
      throw new Error("not used");
    },
    async listWorkspaceAppMentionCandidates() {
      throw new Error("not used");
    },
    async addWorkspaceIssueContextRefs() {
      throw new Error("not used");
    },
    async addWorkspaceIssueTaskContextRefs() {
      throw new Error("not used");
    },
    async listWorkspaceAppReferences() {
      throw new Error("not used");
    },
    async searchWorkspaceAppReferences() {
      throw new Error("not used");
    },
    async prepareWorkspaceAppUpload() {
      throw new Error("not used");
    },
    async completeWorkspaceAppUpload() {
      throw new Error("not used");
    },
    async cancelWorkspaceAppUpload() {
      throw new Error("not used");
    },
    async installWorkspaceApp() {
      throw new Error("not used");
    },
    async exportWorkspaceApp() {
      throw new Error("not used");
    },
    async importWorkspaceApp() {
      throw new Error("not used");
    },
    async loadLocalWorkspaceApp() {
      throw new Error("not used");
    },
    async replaceWorkspaceAppIcon() {
      throw new Error("not used");
    },
    async reloadLocalWorkspaceApp() {
      throw new Error("not used");
    },
    async cancelWorkspaceAppFactoryJob() {
      throw new Error("not used");
    },
    async deleteWorkspaceAppFactoryJob() {
      throw new Error("not used");
    },
    async deleteWorkspaceApp() {
      throw new Error("not used");
    },
    async completeWorkspaceIssueTaskRun() {
      throw new Error("not used");
    },
    async completeWorkspaceIssueRun() {
      throw new Error("not used");
    },
    async createWorkspaceIssue() {
      throw new Error("not used");
    },
    async createWorkspaceIssueTopic() {
      throw new Error("not used");
    },
    async createWorkspaceIssueTask() {
      throw new Error("not used");
    },
    async createWorkspaceIssueTasks() {
      throw new Error("not used");
    },
    async createWorkspaceIssueTaskRun() {
      throw new Error("not used");
    },
    async createWorkspaceIssueRun() {
      throw new Error("not used");
    },
    async createWorkspace() {
      throw new Error("not used");
    },
    async createWorkspaceAgentSession() {
      throw new Error("not used");
    },
    async updateWorkspaceAgentSessionVisibility() {
      throw new Error("not used");
    },
    async createWorkspaceAppFactoryJob() {
      throw new Error("not used");
    },
    async createWorkspaceTerminal() {
      throw new Error("not used");
    },
    async createWorkspaceFile() {
      throw new Error("not used");
    },
    async readWorkspaceFilePreview() {
      throw new Error("not used");
    },
    async writeWorkspaceFileText() {
      throw new Error("not used");
    },
    async createWorkspaceFileDirectory() {
      throw new Error("not used");
    },
    async deleteWorkspace() {
      throw new Error("not used");
    },
    async deleteWorkspaceAgentSession() {
      throw new Error("not used");
    },
    async deleteWorkspaceAgentSessionsBatch() {
      throw new Error("not used");
    },
    async updateWorkspaceAgentSessionTitle() {
      throw new Error("not used");
    },
    async clearWorkspaceAgentSessions() {
      throw new Error("not used");
    },
    async deleteWorkspaceIssue() {
      throw new Error("not used");
    },
    async deleteWorkspaceIssueTopic() {
      throw new Error("not used");
    },
    async deleteWorkspaceIssueTask() {
      throw new Error("not used");
    },
    async deleteWorkspaceFileEntry() {
      throw new Error("not used");
    },
    async moveWorkspaceFileEntry() {
      throw new Error("not used");
    },
    async renameWorkspaceFileEntry() {
      throw new Error("not used");
    },
    async copyWorkspaceFileEntry() {
      throw new Error("not used");
    },
    async getDesktopPreferences() {
      throw new Error("not used");
    },
    async getHealth() {
      return { service: "tuttid", status: "ok" as const };
    },
    async getStartupWorkspace() {
      return null;
    },
    async getWorkspace() {
      throw new Error("not used");
    },
    async getWorkspaceAgentSession() {
      throw new Error("not used");
    },
    async getWorkspaceAppFactoryJob() {
      throw new Error("not used");
    },
    async getWorkspaceAppFactoryAgentTargetComposerOptions() {
      throw new Error("not used");
    },
    async getAgentProviderComposerOptions() {
      throw new Error("not used");
    },
    async getAgentProviderStatuses() {
      throw new Error("not used");
    },
    async probeAgentProvider() {
      throw new Error("not used");
    },
    async runAgentProviderAction() {
      throw new Error("not used");
    },
    async getWorkspaceIssueDetail() {
      throw new Error("not used");
    },
    async searchWorkspaceIssueReferences() {
      throw new Error("not used");
    },
    async getWorkspaceIssueTaskDetail() {
      throw new Error("not used");
    },
    async getWorkspaceIssueTaskRun() {
      throw new Error("not used");
    },
    async getWorkspaceIssueRun() {
      throw new Error("not used");
    },
    async getWorkspaceTerminal() {
      throw new Error("not used");
    },
    async getWorkspaceTerminalSnapshot() {
      throw new Error("not used");
    },
    async getWorkspaceWorkbench() {
      throw new Error("not used");
    },
    async getWorkspaceFileTreeSnapshot() {
      throw new Error("not used");
    },
    async listWorkspaceIssues() {
      throw new Error("not used");
    },
    async listWorkspaceIssueTopics() {
      throw new Error("not used");
    },
    async listWorkspaceIssueTaskRuns() {
      throw new Error("not used");
    },
    async listWorkspaceIssueRuns() {
      throw new Error("not used");
    },
    async listWorkspaceIssueTasks() {
      throw new Error("not used");
    },
    async listWorkspaceFileDirectory() {
      throw new Error("not used");
    },
    async listWorkspaceRecentFiles() {
      throw new Error("not used");
    },
    async listWorkspaceAgentSessionMessages() {
      throw new Error("not used");
    },
    async listWorkspaceAgentGeneratedFiles() {
      throw new Error("not used");
    },
    async listUserProjects() {
      throw new Error("not used");
    },
    async moveUserProject() {
      throw new Error("not used");
    },
    async pinUserProject() {
      throw new Error("not used");
    },
    async deleteUserProject() {
      throw new Error("not used");
    },
    async checkUserProjectPath() {
      throw new Error("not used");
    },
    async listWorkspaces() {
      return { totalCount: 0, workspaces: [] };
    },
    async listWorkspaceApps() {
      throw new Error("not used");
    },
    async refreshWorkspaceAppCatalog() {
      throw new Error("not used");
    },
    async listWorkspaceAppFactoryJobs() {
      throw new Error("not used");
    },
    async listWorkspaceTerminals() {
      throw new Error("not used");
    },
    async listWorkspaceAgentSessions() {
      throw new Error("not used");
    },
    async listWorkspaceAgentSessionSections() {
      throw new Error("not used");
    },
    async listWorkspaceAgentSessionSectionPage() {
      throw new Error("not used");
    },
    async listWorkspaceAgentSessionSectionDeletionCandidates() {
      throw new Error("not used");
    },
    async listWorkspaceAgentPinnedSessionPage() {
      throw new Error("not used");
    },
    async scanWorkspaceExternalAgentSessionImports() {
      throw new Error("not used");
    },
    async importWorkspaceExternalAgentSessions() {
      throw new Error("not used");
    },
    async openWorkspace() {
      throw new Error("not used");
    },
    async removeWorkspaceIssueContextRef() {
      throw new Error("not used");
    },
    async removeWorkspaceIssueTaskContextRef() {
      throw new Error("not used");
    },
    async preflightUploadWorkspaceFiles() {
      throw new Error("not used");
    },
    async putWorkspaceWorkbench() {
      throw new Error("not used");
    },
    async uninstallWorkspaceApp() {
      throw new Error("not used");
    },
    async checkWorkspaceTerminalCloseGuard() {
      throw new Error("not used");
    },
    async resizeWorkspaceTerminal() {
      throw new Error("not used");
    },
    async cancelWorkspaceAgentTurn() {
      throw new Error("not used");
    },
    async goalControlWorkspaceAgentSession() {
      throw new Error("not used");
    },
    async getWorkspaceAgentSessionGoal() {
      throw new Error("not used");
    },
    async reconcileWorkspaceAgentSessionGoal() {
      throw new Error("not used");
    },
    async sendWorkspaceAgentSessionInput() {
      throw new Error("not used");
    },
    async submitWorkspaceAgentPlanDecision() {
      throw new Error("not used");
    },
    async readWorkspaceAgentSessionAttachment() {
      throw new Error("not used");
    },
    async listWorkspaceAgentSessionGitBranches() {
      throw new Error("not used");
    },
    async listWorkspaceGitBranches() {
      throw new Error("not used");
    },
    async resolveWorkspaceGitPatchSupport() {
      throw new Error("not used");
    },
    async updateWorkspaceAgentSessionSettings() {
      throw new Error("not used");
    },
    async updateWorkspaceAgentSessionPin() {
      throw new Error("not used");
    },
    async submitWorkspaceAgentInteractive() {
      throw new Error("not used");
    },
    async launchWorkspaceApp() {
      throw new Error("not used");
    },
    async retryWorkspaceApp() {
      throw new Error("not used");
    },
    async retryWorkspaceAppFactoryJobValidation() {
      throw new Error("not used");
    },
    async fixWorkspaceAppFactoryJob() {
      throw new Error("not used");
    },
    async prepareWorkspaceAppFactoryJobModification() {
      throw new Error("not used");
    },
    async publishWorkspaceAppFactoryJob() {
      throw new Error("not used");
    },
    async rollbackWorkspaceApp() {
      throw new Error("not used");
    },
    async searchWorkspaceFiles() {
      throw new Error("not used");
    },
    async startEnabledWorkspaceApps() {
      throw new Error("not used");
    },
    async stopAllWorkspaceApps() {
      throw new Error("not used");
    },
    async putDesktopPreferences() {
      throw new Error("not used");
    },
    async updateWorkspaceIssue() {
      throw new Error("not used");
    },
    async updateWorkspaceIssueTask() {
      throw new Error("not used");
    },
    async updateWorkspaceIssueTopic() {
      throw new Error("not used");
    },
    async updateWorkspace() {
      throw new Error("not used");
    },
    async uploadWorkspaceFiles() {
      throw new Error("not used");
    },
    async terminateWorkspaceTerminal() {
      throw new Error("not used");
    },
    async trackEvents() {},
    async useUserProject() {
      throw new Error("not used");
    }
  };
  return Object.assign(client, overrides);
}

test("workspace host access delegates workspace window handoff", async () => {
  const events: string[] = [];
  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      events.push("owner:closed");
    }
  };
  const workspaceHostAccess = createWorkspaceHostAccess({
    workspaceLaunch: createWorkspaceLaunch({
      adapters: createAdapters({
        async showWorkspaceWindow(workspaceID) {
          events.push(`workspace:${workspaceID}`);
        }
      }),
      tuttidClient: createTransportClient()
    })
  });

  await workspaceHostAccess.showWorkspace(ownerWindow, "ws-alpha");

  assert.deepEqual(events, ["workspace:ws-alpha", "owner:closed"]);
});

test("workspace host access delegates open workspace app folder without exposing a path", async () => {
  const openedApps: DesktopWorkspaceAppPayload[] = [];
  const workspaceHostAccess = createWorkspaceHostAccess({
    openWorkspaceAppFolder: async (payload) => {
      openedApps.push(payload);
    },
    workspaceLaunch: createWorkspaceLaunch({
      adapters: createAdapters(),
      tuttidClient: createTransportClient()
    })
  });

  await workspaceHostAccess.openWorkspaceAppFolder({
    appId: "notes",
    folderKind: "data",
    workspaceId: "ws-alpha"
  });

  assert.deepEqual(openedApps, [
    {
      appId: "notes",
      folderKind: "data",
      workspaceId: "ws-alpha"
    }
  ]);
});
