import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttidClient,
  WorkbenchSnapshot,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  createWorkspaceLaunch,
  type WorkspaceLaunchAdapters,
  type WorkspaceLaunchOwnerWindow
} from "./workspaceLaunch.ts";

function createWorkspaceSummary(id: string): WorkspaceSummary {
  return {
    id,
    name: `Workspace ${id}`,
    lastOpenedAt: "2026-05-21T08:00:00Z"
  };
}

function createWorkbenchSnapshot(): WorkbenchSnapshot {
  return {
    schemaVersion: 1,
    nodes: [],
    nodeStack: [],
    activeNodeId: null
  };
}

function createAdapters(
  overrides: Partial<WorkspaceLaunchAdapters> = {}
): WorkspaceLaunchAdapters {
  return {
    async showWorkspaceWindow() {},
    warnStartupWindowResolutionFailure() {},
    ...overrides
  };
}

function createTransportClient(
  overrides: Partial<TuttidClient> = {}
): TuttidClient {
  return {
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
    async checkWorkspaceTerminalCloseGuard() {
      throw new Error("not used");
    },
    async completeWorkspaceIssueTaskRun() {
      throw new Error("not used");
    },
    async completeWorkspaceIssueRun() {
      throw new Error("not used");
    },
    async createWorkspace() {
      return createWorkspaceSummary("unused");
    },
    async createWorkspaceIssueTopic() {
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
    async createWorkspaceFile(_workspaceID, path) {
      return {
        entry: {
          createdTimeMs: null,
          hasChildren: false,
          kind: "file",
          lastOpenedMs: null,
          mtimeMs: null,
          name: path.split("/").at(-1) ?? path,
          path,
          sizeBytes: 0
        },
        root: "/workspace",
        workspaceId: _workspaceID
      };
    },
    async readWorkspaceFilePreview(_workspaceID, path) {
      return {
        bytesBase64: "",
        name: path.split("/").at(-1) ?? path,
        path,
        root: "/workspace",
        sizeBytes: 0,
        workspaceId: _workspaceID
      };
    },
    async writeWorkspaceFileText(_workspaceID, request) {
      return {
        entry: {
          createdTimeMs: null,
          hasChildren: false,
          kind: "file",
          lastOpenedMs: null,
          mtimeMs: null,
          name: request.path.split("/").at(-1) ?? request.path,
          path: request.path,
          sizeBytes: request.content.length
        },
        root: "/workspace",
        workspaceId: _workspaceID
      };
    },
    async createWorkspaceFileDirectory(_workspaceID, path) {
      return {
        entry: {
          createdTimeMs: null,
          hasChildren: false,
          kind: "directory",
          lastOpenedMs: null,
          mtimeMs: null,
          name: path.split("/").at(-1) ?? path,
          path,
          sizeBytes: null
        },
        root: "/workspace",
        workspaceId: _workspaceID
      };
    },
    async createWorkspaceIssue() {
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
    async createWorkspaceTerminal() {
      throw new Error("not used");
    },
    async deleteWorkspaceAgentSession() {
      throw new Error("not used");
    },
    async clearWorkspaceAgentSessions() {
      throw new Error("not used");
    },
    async deleteWorkspace(workspaceID) {
      return { workspaceId: workspaceID };
    },
    async deleteWorkspaceFileEntry(workspaceID, request) {
      return { path: request.path, workspaceId: workspaceID };
    },
    async moveWorkspaceFileEntry(workspaceID, request) {
      return {
        entry: {
          createdTimeMs: null,
          hasChildren: false,
          kind: "file",
          lastOpenedMs: null,
          mtimeMs: null,
          name: request.path.split("/").at(-1) ?? request.path,
          path: `${request.targetDirectoryPath}/${request.path.split("/").at(-1) ?? request.path}`,
          sizeBytes: 0
        },
        root: "/workspace",
        workspaceId: workspaceID
      };
    },
    async renameWorkspaceFileEntry(workspaceID, request) {
      return {
        entry: {
          createdTimeMs: null,
          hasChildren: false,
          kind: "file",
          lastOpenedMs: null,
          mtimeMs: null,
          name: request.newName,
          path: `${request.path.split("/").slice(0, -1).join("/")}/${request.newName}`,
          sizeBytes: 0
        },
        root: "/workspace",
        workspaceId: workspaceID
      };
    },
    async copyWorkspaceFileEntry(workspaceID, request) {
      const baseName = request.path.split("/").at(-1) ?? request.path;
      return {
        entry: {
          createdTimeMs: null,
          hasChildren: false,
          kind: "file",
          lastOpenedMs: null,
          mtimeMs: null,
          name: `${baseName} copy`,
          path: `${request.path.split("/").slice(0, -1).join("/")}/${baseName} copy`,
          sizeBytes: 0
        },
        root: "/workspace",
        workspaceId: workspaceID
      };
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
    async getDesktopPreferences() {
      throw new Error("not used");
    },
    async getHealth() {
      return { service: "tuttid", status: "ok" as const };
    },
    async getStartupWorkspace() {
      return null;
    },
    async getWorkspace(workspaceID) {
      return createWorkspaceSummary(workspaceID);
    },
    async getWorkspaceAgentSession() {
      throw new Error("not used");
    },
    async getWorkspaceAppFactoryJob() {
      throw new Error("not used");
    },
    async getWorkspaceAppFactoryProviderComposerOptions() {
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
      return createWorkbenchSnapshot();
    },
    async getWorkspaceFileTreeSnapshot(workspaceID, request) {
      const path = request?.path ?? "/workspace";
      return {
        budgetExceeded: false,
        directory: {
          directoryPath: path,
          entries: [],
          prefetchState: "loaded" as const
        },
        prefetchBudgetMs: request?.prefetchBudgetMs ?? 500,
        prefetchDepth: request?.prefetchDepth ?? 4,
        root: "/workspace",
        workspaceId: workspaceID
      };
    },
    async listWorkspaceFileDirectory(workspaceID, request) {
      const path = request?.path ?? "/workspace";
      return {
        directoryPath: path,
        entries: [],
        root: "/workspace",
        workspaceId: workspaceID
      };
    },
    async listWorkspaceRecentFiles(workspaceID) {
      return {
        directoryPath: "/workspace",
        entries: [],
        root: "/workspace",
        workspaceId: workspaceID
      };
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
    async listWorkspaceIssues() {
      throw new Error("not used");
    },
    async listWorkspaceIssueTopics() {
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
    async deleteUserProject() {
      throw new Error("not used");
    },
    async checkUserProjectPath() {
      throw new Error("not used");
    },
    async listWorkspaceTerminals(workspaceID) {
      return { terminals: [], workspaceId: workspaceID };
    },
    async listWorkspaceAgentSessions(workspaceID) {
      return { sessions: [], workspaceId: workspaceID };
    },
    async scanWorkspaceExternalAgentSessionImports() {
      throw new Error("not used");
    },
    async importWorkspaceExternalAgentSessions() {
      throw new Error("not used");
    },
    async listWorkspaces() {
      return { workspaces: [], totalCount: 0 };
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
    async openWorkspace(workspaceID) {
      return createWorkspaceSummary(workspaceID);
    },
    async preflightUploadWorkspaceFiles(workspaceID, request) {
      return {
        conflicts: [],
        root: "/workspace",
        targetDirectoryPath: request.targetDirectoryPath,
        workspaceId: workspaceID
      };
    },
    async putWorkspaceWorkbench(_workspaceID, snapshot) {
      return snapshot;
    },
    async uninstallWorkspaceApp() {
      throw new Error("not used");
    },
    async removeWorkspaceIssueContextRef() {
      throw new Error("not used");
    },
    async removeWorkspaceIssueTaskContextRef() {
      throw new Error("not used");
    },
    async resizeWorkspaceTerminal() {
      throw new Error("not used");
    },
    async cancelWorkspaceAgentSession() {
      throw new Error("not used");
    },
    async cancelWorkspaceAgentSessionWithResult() {
      throw new Error("not used");
    },
    async sendWorkspaceAgentSessionInput() {
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
    async searchWorkspaceFiles(workspaceID) {
      return {
        entries: [],
        root: "/workspace",
        workspaceId: workspaceID
      };
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
    async terminateWorkspaceTerminal() {
      throw new Error("not used");
    },
    async trackEvents() {},
    async useUserProject() {
      throw new Error("not used");
    },
    async updateWorkspace(workspaceID) {
      return createWorkspaceSummary(workspaceID);
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
    async uploadWorkspaceFiles(workspaceID, request) {
      return {
        entries: request.sourcePaths.map((sourcePath) => ({
          createdTimeMs: null,
          hasChildren: false,
          kind: "file",
          lastOpenedMs: null,
          mtimeMs: null,
          name: sourcePath.split("/").at(-1) ?? sourcePath,
          path: `${request.targetDirectoryPath}/${sourcePath.split("/").at(-1) ?? sourcePath}`,
          sizeBytes: 0
        })),
        root: "/workspace",
        targetDirectoryPath: request.targetDirectoryPath,
        workspaceId: workspaceID
      };
    },
    ...overrides
  };
}

test("workspace launch opens daemon-provided startup workspace", async () => {
  let openedWorkspaceID: string | null = null;
  let listCalled = false;

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID) {
        openedWorkspaceID = workspaceID;
      }
    }),
    tuttidClient: createTransportClient({
      async getStartupWorkspace() {
        return createWorkspaceSummary("ws-start");
      },
      async listWorkspaces() {
        listCalled = true;
        return { totalCount: 0, workspaces: [] };
      }
    })
  });

  await launch.openStartupWindow();

  assert.equal(openedWorkspaceID, "ws-start");
  assert.equal(listCalled, false);
});

test("workspace launch opens the existing personal workspace when no startup workspace is set", async () => {
  const events: string[] = [];

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID) {
        events.push(`show:${workspaceID}`);
      }
    }),
    tuttidClient: createTransportClient({
      async getStartupWorkspace() {
        events.push("startup");
        return createWorkspaceSummary("ws-existing");
      }
    })
  });

  await launch.openStartupWindow();

  assert.deepEqual(events, ["startup", "show:ws-existing"]);
});

test("workspace launch creates and opens the default workspace when the catalog is empty", async () => {
  const events: string[] = [];

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID) {
        events.push(`show:${workspaceID}`);
      }
    }),
    tuttidClient: createTransportClient({
      async getStartupWorkspace() {
        events.push("startup");
        return createWorkspaceSummary("ws-default");
      }
    })
  });

  await launch.openStartupWindow();

  assert.deepEqual(events, ["startup", "show:ws-default"]);
});

test("workspace launch warns and rejects when startup resolution fails", async () => {
  let warnedError: unknown = null;

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      warnStartupWindowResolutionFailure(error) {
        warnedError = error;
      }
    }),
    tuttidClient: createTransportClient({
      async getStartupWorkspace() {
        throw new Error("boom");
      }
    })
  });

  await assert.rejects(launch.openStartupWindow(), /boom/);
  assert.ok(warnedError instanceof Error);
  assert.equal(warnedError.message, "boom");
});

test("workspace launch waits for replacement workspace window before closing owner", async () => {
  let ownerWindowClosed = false;
  let resolveWorkspaceWindow: (() => void) | null = null;

  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      ownerWindowClosed = true;
    }
  };

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow() {
        await new Promise<void>((resolve) => {
          resolveWorkspaceWindow = resolve;
        });
      }
    }),
    tuttidClient: createTransportClient()
  });

  const openPromise = launch.showWorkspace(ownerWindow, "ws-alpha");
  await Promise.resolve();

  assert.equal(ownerWindowClosed, false);
  if (!resolveWorkspaceWindow) {
    throw new Error("workspace window open resolver was not assigned");
  }
  const finishWorkspaceWindowOpen = resolveWorkspaceWindow as () => void;
  finishWorkspaceWindowOpen();

  await openPromise;
  assert.equal(ownerWindowClosed, true);
});

test("workspace launch prefers destroying owner windows after workspace handoff", async () => {
  const events: string[] = [];

  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      events.push("owner:closed");
    },
    destroy() {
      events.push("owner:destroyed");
    }
  };

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow(workspaceID) {
        events.push(`workspace:${workspaceID}`);
      }
    }),
    tuttidClient: createTransportClient()
  });

  await launch.showWorkspace(ownerWindow, "ws-destroy");

  assert.deepEqual(events, ["workspace:ws-destroy", "owner:destroyed"]);
});

test("workspace launch keeps owner open when replacement workspace window fails", async () => {
  let ownerWindowClosed = false;

  const ownerWindow: WorkspaceLaunchOwnerWindow = {
    close() {
      ownerWindowClosed = true;
    }
  };

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow() {
        throw new Error("renderer failed");
      }
    }),
    tuttidClient: createTransportClient()
  });

  await assert.rejects(
    launch.showWorkspace(ownerWindow, "ws-alpha"),
    /renderer failed/
  );
  assert.equal(ownerWindowClosed, false);
});

test("workspace launch warns and rejects when startup workspace window fails", async () => {
  let warnedError: unknown = null;

  const launch = createWorkspaceLaunch({
    adapters: createAdapters({
      async showWorkspaceWindow() {
        throw new Error("workspace failed");
      },
      warnStartupWindowResolutionFailure(error) {
        warnedError = error;
      }
    }),
    tuttidClient: createTransportClient({
      async getStartupWorkspace() {
        return createWorkspaceSummary("ws-start");
      }
    })
  });

  await assert.rejects(launch.openStartupWindow(), /workspace failed/);
  assert.ok(warnedError instanceof Error);
  assert.equal(warnedError.message, "workspace failed");
});
