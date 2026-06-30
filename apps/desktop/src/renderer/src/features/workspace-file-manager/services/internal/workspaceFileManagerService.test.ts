import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  TuttidProtocolError,
  type TuttidClient
} from "@tutti-os/client-tuttid-ts";
import {
  createWorkspaceFileManagerI18nRuntime,
  type WorkspaceFileManagerPersistedState,
  workspaceFileManagerI18nResources
} from "@tutti-os/workspace-file-manager/services";
import type { WorkspaceUserProject } from "@tutti-os/workspace-user-project/contracts";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { DesktopHostFilesApi, DesktopPlatformApi } from "@preload/types";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { applyLocale } from "../../../../i18n/runtime.ts";
import {
  WorkspaceFileManagerService,
  type WorkspaceFileManagerServiceDependencies
} from "./workspaceFileManagerService.ts";
import {
  DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID,
  DESKTOP_WORKSPACE_FILE_LOCAL_SECTION_ID,
  DESKTOP_WORKSPACE_FILE_PROJECT_SECTION_ID,
  DESKTOP_WORKSPACE_FILE_RECENT_LOCATION_ID,
  buildDesktopWorkspaceFileLocationSections
} from "../desktopWorkspaceFileLocations.ts";
import { createDesktopWorkspaceFileManagerAdapter } from "./desktopWorkspaceFileManagerAdapter.ts";

test("workspace file manager service reuses one long-lived session per workspace", () => {
  const service = new WorkspaceFileManagerService(createDependenciesStub());
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );

  const first = service.getSession("workspace-1", copy);
  const second = service.getSession("workspace-1", copy);
  const third = service.getSession("workspace-2", copy);

  assert.equal(first, second);
  assert.notEqual(first, third);
});

test("workspace file manager service does not refresh unchanged locations during repeated session lookup", async () => {
  const userProjects = createWorkspaceUserProjectServiceStub();
  const dependencies = createDependenciesStub();
  dependencies.workspaceUserProjectService = userProjects.service;
  const service = new WorkspaceFileManagerService(dependencies);
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
  const notifications: number[] = [];
  service.subscribe("workspace-1", () => {
    notifications.push(notifications.length + 1);
  });

  const first = service.getSession("workspace-1", copy);
  await flushMicrotasks();
  notifications.length = 0;
  userProjects.resetEnsureLoadedCalls();
  const second = service.getSession("workspace-1", copy);
  await flushMicrotasks();

  assert.equal(first, second);
  assert.equal(userProjects.ensureLoadedCalls, 0);
  assert.deepEqual(notifications, []);

  userProjects.emit();
  await flushMicrotasks();

  assert.equal(userProjects.ensureLoadedCalls, 1);
  assert.deepEqual(notifications, []);
});

test("workspace file manager service defaults new sessions to the user home directory", () => {
  const service = new WorkspaceFileManagerService(createDependenciesStub());
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );

  const session = service.getSession("workspace-1", copy);

  assert.equal(session.store.currentDirectoryPath, "/Users/local");
});

test("workspace file manager service checks whether an entry exists by listing its parent", async () => {
  const dependencies = createDependenciesStub();
  let capturedWorkspaceId: string | undefined;
  let capturedRequest:
    | Parameters<TuttidClient["listWorkspaceFileDirectory"]>[1]
    | undefined;
  dependencies.tuttidClient.listWorkspaceFileDirectory = async (
    workspaceId,
    input
  ) => {
    capturedWorkspaceId = workspaceId;
    capturedRequest = input;
    return {
      directoryPath: input?.path || "/Users/local/project",
      entries: [
        {
          createdTimeMs: null,
          hasChildren: false,
          kind: "file",
          lastOpenedMs: null,
          mtimeMs: null,
          name: "README.md",
          path: "/Users/local/project/README.md",
          sizeBytes: 12
        }
      ],
      root: "/Users/local/project",
      workspaceId
    };
  };
  const service = new WorkspaceFileManagerService(dependencies);

  assert.equal(
    await service.entryExists({
      path: "/Users/local/project/README.md",
      workspaceID: "workspace-1"
    }),
    true
  );
  assert.equal(capturedWorkspaceId, "workspace-1");
  assert.deepEqual(capturedRequest, {
    includeHidden: true,
    path: "/Users/local/project"
  });
});

test("workspace file manager service treats missing or unreadable entries as absent", async () => {
  const dependencies = createDependenciesStub();
  dependencies.tuttidClient.listWorkspaceFileDirectory = async (
    workspaceId,
    input
  ) => ({
    directoryPath: input?.path || "/Users/local/project",
    entries: [],
    root: "/Users/local/project",
    workspaceId
  });
  const service = new WorkspaceFileManagerService(dependencies);

  assert.equal(
    await service.entryExists({
      path: "/Users/local/project/MISSING.md",
      workspaceID: "workspace-1"
    }),
    false
  );

  dependencies.tuttidClient.listWorkspaceFileDirectory = async () => {
    throw new Error("missing parent");
  };

  assert.equal(
    await service.entryExists({
      path: "/Users/local/project/MISSING.md",
      workspaceID: "workspace-1"
    }),
    false
  );
});

test("workspace file manager service restores snapshot state without localStorage", () => {
  const restoreStorage = installForbiddenLocalStorage();
  try {
    const service = new WorkspaceFileManagerService(createDependenciesStub());
    const copy = createWorkspaceFileManagerI18nRuntime(
      createI18nRuntime({
        dictionaries: [workspaceFileManagerI18nResources.en]
      })
    );
    const restoredState: WorkspaceFileManagerPersistedState = {
      currentDirectoryPath: "/Users/demo/project/docs",
      navigationBackStack: ["/Users/demo/project"],
      navigationForwardStack: ["/Users/demo/project/archive"],
      selectedLocationId: null,
      schemaVersion: 3
    };

    const first = service.getSession("workspace-1", copy, restoredState);
    const second = service.getSession("workspace-1", copy, {
      currentDirectoryPath: "/Users/demo/project/ignored",
      navigationBackStack: [],
      navigationForwardStack: [],
      selectedLocationId: null,
      schemaVersion: 3
    });

    assert.equal(first, second);
    assert.equal(first.store.currentDirectoryPath, "/Users/demo/project/docs");
    assert.equal(first.store.selectedPath, null);
    assert.deepEqual(service.getSnapshotState("workspace-1"), {
      ...restoredState,
      selectedLocationId: DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID
    });
  } finally {
    restoreStorage();
  }
});

test("workspace file manager service falls back to home when restored state is invalid", () => {
  const service = new WorkspaceFileManagerService(createDependenciesStub());
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );

  const session = service.getSession("workspace-1", copy, {
    currentDirectoryPath: 123,
    navigationBackStack: [],
    navigationForwardStack: [],
    selectedLocationId: null,
    schemaVersion: 3
  } as unknown as WorkspaceFileManagerPersistedState);

  assert.equal(session.store.currentDirectoryPath, "/Users/local");
});

test("workspace file manager service notifies only restorable snapshot changes", async () => {
  const dependencies = createDependenciesStub();
  dependencies.tuttidClient.listWorkspaceFileDirectory = async (
    workspaceId,
    input
  ) => ({
    directoryPath: input?.path || "/Users/demo/project",
    entries: [],
    root: "/Users/demo/project",
    workspaceId
  });
  const service = new WorkspaceFileManagerService(dependencies);
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
  const notifications: number[] = [];
  const dispose = service.subscribe("workspace-1", () => {
    notifications.push(notifications.length + 1);
  });
  const session = service.getSession("workspace-1", copy);
  await session.initialize();
  notifications.length = 0;

  session.select("/Users/demo/project/file.txt");
  await flushMicrotasks();
  assert.deepEqual(notifications, []);

  session.store.currentDirectoryPath = "/Users/demo/project/docs";
  await flushMicrotasks();
  assert.deepEqual(notifications, [1]);

  dispose();
});

test("workspace file manager service sends mutation errors through error notifications", async () => {
  applyLocale("en");
  const dependencies = createDependenciesStub();
  dependencies.tuttidClient.listWorkspaceFileDirectory = async (
    workspaceId,
    input
  ) => ({
    directoryPath: input?.path || "/Users/demo/project",
    entries: [],
    root: "/Users/demo/project",
    workspaceId
  });
  dependencies.tuttidClient.createWorkspaceFile = async () => {
    throw new TuttidProtocolError({
      code: "invalid_request",
      reason: "entry_already_exists",
      statusCode: 400
    });
  };
  const notifications = createNotificationRecorder();
  const service = new WorkspaceFileManagerService(
    dependencies,
    notifications.service
  );
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
  const session = service.getSession("workspace-1", copy);
  await session.initialize();

  await session.createFile("/Users/demo/project/notes.txt");

  assert.equal(session.store.error, null);
  assert.deepEqual(notifications.items, [
    {
      description: undefined,
      title: "That file or folder already exists at this path.",
      tone: "error"
    }
  ]);
});

test("workspace file manager service leaves list failures in file manager state", async () => {
  applyLocale("en");
  const dependencies = createDependenciesStub();
  dependencies.tuttidClient.listWorkspaceFileDirectory = async () => {
    throw new TuttidProtocolError({
      code: "invalid_request",
      reason: "invalid_path",
      statusCode: 400
    });
  };
  const notifications = createNotificationRecorder();
  const service = new WorkspaceFileManagerService(
    dependencies,
    notifications.service
  );
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
  const session = service.getSession("workspace-1", copy);

  await session.initialize();

  assert.equal(session.store.error, "That path is invalid.");
  assert.deepEqual(notifications.items, []);
});

test("workspace file manager service reports file created after successful file creation", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const dependencies = createDependenciesStub();
  dependencies.tuttidClient.createWorkspaceFile = async (
    workspaceId,
    path
  ) => ({
    entry: {
      createdTimeMs: null,
      hasChildren: false,
      kind: "file",
      lastOpenedMs: null,
      mtimeMs: null,
      name: "notes.txt",
      path,
      sizeBytes: 0
    },
    root: "/Users/demo/project",
    workspaceId
  });
  dependencies.tuttidClient.listWorkspaceFileDirectory = async (
    workspaceId,
    input
  ) => ({
    directoryPath: input?.path || "/Users/demo/project",
    entries: [],
    root: "/Users/demo/project",
    workspaceId
  });
  dependencies.reporterService = createReporterService(reporterCalls);
  const service = new WorkspaceFileManagerService(dependencies);
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
  const session = service.getSession("workspace-1", copy);
  await session.initialize();

  await session.createFile("/Users/demo/project/docs/notes.txt");

  assert.equal(reporterCalls.length, 1);
  assert.deepEqual(reporterCalls[0], [
    {
      clientTS: reporterCalls[0]?.[0]?.clientTS,
      name: "file_manager.file_created",
      params: {}
    }
  ]);
});

test("workspace file manager service reports opened after successful file activation", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const dependencies = createDependenciesStub();
  const openedFiles: Array<{ path: string; workspaceId: string }> = [];
  dependencies.hostFilesApi.openFile = async (workspaceId, path) => {
    openedFiles.push({ path, workspaceId });
  };
  dependencies.reporterService = createReporterService(reporterCalls);
  const service = new WorkspaceFileManagerService(dependencies);
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
  const session = service.getSession("workspace-1", copy);

  await session.activateFile({
    entry: {
      hasChildren: false,
      kind: "file",
      mtimeMs: null,
      name: "notes.txt",
      path: "/Users/demo/project/notes.txt",
      sizeBytes: 5
    },
    target: null
  });

  assert.deepEqual(openedFiles, [
    {
      path: "/Users/demo/project/notes.txt",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(reporterCalls.length, 1);
  assert.deepEqual(reporterCalls[0], [
    {
      clientTS: reporterCalls[0]?.[0]?.clientTS,
      name: "file_manager.opened",
      params: {
        source: "file_manager",
        trigger: "manual"
      }
    }
  ]);
});

test("workspace file manager service does not report opened after failed file activation", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const dependencies = createDependenciesStub();
  dependencies.hostFilesApi.openFile = async () => {
    throw new Error("open failed");
  };
  dependencies.reporterService = createReporterService(reporterCalls);
  const service = new WorkspaceFileManagerService(dependencies);
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
  const session = service.getSession("workspace-1", copy);

  await session.activateFile({
    entry: {
      hasChildren: false,
      kind: "file",
      mtimeMs: null,
      name: "notes.txt",
      path: "/Users/demo/project/notes.txt",
      sizeBytes: 5
    },
    target: null
  });

  assert.deepEqual(reporterCalls, []);
});

test("workspace file manager service includes hidden entries for direct reveal into a hidden path", async () => {
  const dependencies = createDependenciesStub();
  let capturedRequest:
    | Parameters<TuttidClient["listWorkspaceFileDirectory"]>[1]
    | undefined;
  dependencies.tuttidClient.listWorkspaceFileDirectory = async (
    workspaceId,
    input
  ) => {
    capturedRequest = input;
    return {
      directoryPath: input?.path || "/Users/demo",
      entries: [
        {
          createdTimeMs: null,
          hasChildren: false,
          kind: "file",
          lastOpenedMs: null,
          mtimeMs: null,
          name: "image.png",
          path: "/Users/demo/.tutti-dev/agent/runs/session-1/codex-home/generated_images/image.png",
          sizeBytes: 5
        }
      ],
      root: "/Users/demo",
      workspaceId
    };
  };
  const service = new WorkspaceFileManagerService(dependencies);
  const copy = createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
  const session = service.getSession("workspace-1", copy);

  await session.revealPath(
    "/Users/demo/.tutti-dev/agent/runs/session-1/codex-home/generated_images/image.png"
  );

  assert.equal(capturedRequest?.includeHidden, true);
  assert.equal(
    capturedRequest?.path,
    "/Users/demo/.tutti-dev/agent/runs/session-1/codex-home/generated_images"
  );
  assert.equal(
    session.store.selectedPath,
    "/Users/demo/.tutti-dev/agent/runs/session-1/codex-home/generated_images/image.png"
  );
});

test("desktop workspace file locations include projects and local entries", () => {
  const sections = buildDesktopWorkspaceFileLocationSections({
    homeDirectory: "/Users/local",
    projects: [
      {
        id: "project-1",
        label: "Repo (/Users/local/repo)",
        path: "/Users/local/repo"
      }
    ]
  });

  assert.equal(sections[0]?.id, DESKTOP_WORKSPACE_FILE_PROJECT_SECTION_ID);
  assert.equal(sections[0]?.locations[0]?.id, "project:project-1");
  assert.equal(sections[0]?.locations[0]?.label, "Repo");
  assert.equal(sections[0]?.locations[0]?.kind, "directory");
  assert.equal(sections[0]?.locations[0]?.path, "/Users/local/repo");

  assert.equal(sections[1]?.id, DESKTOP_WORKSPACE_FILE_LOCAL_SECTION_ID);
  assert.deepEqual(
    sections[1]?.locations.map((location) => location.id),
    [
      DESKTOP_WORKSPACE_FILE_RECENT_LOCATION_ID,
      "local:downloads",
      "local:documents",
      "local:desktop",
      DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID
    ]
  );
});

test("desktop workspace file manager adapter forwards recent and scoped search requests", async () => {
  const dependencies = createDependenciesStub();
  let recentLimit: number | undefined;
  let searchWithin: string | undefined;
  dependencies.tuttidClient.listWorkspaceRecentFiles = async (
    workspaceId,
    input
  ) => {
    recentLimit = input?.limit;
    return {
      directoryPath: "/Users/local",
      entries: [],
      root: "/Users/local",
      workspaceId
    };
  };
  dependencies.tuttidClient.searchWorkspaceFiles = async (
    workspaceId,
    input
  ) => {
    searchWithin = input.within;
    return {
      entries: [],
      root: "/Users/local",
      workspaceId
    };
  };
  const adapter = createDesktopWorkspaceFileManagerAdapter(
    {
      ...dependencies,
      notifyPreviewUnsupportedFallback() {},
      notifyRevealFailed() {}
    },
    () => "en"
  );

  await adapter.listRecentEntries?.({
    limit: 7,
    workspaceID: "workspace-1"
  });
  await adapter.search?.({
    query: "app",
    within: "/Users/local/repo",
    workspaceID: "workspace-1"
  });

  assert.equal(recentLimit, 7);
  assert.equal(searchWithin, "/Users/local/repo");
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function installForbiddenLocalStorage(): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("localStorage should not be accessed");
    }
  });

  return () => {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "localStorage", previousDescriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function createWorkspaceUserProjectServiceStub(
  input: {
    projects?: readonly WorkspaceUserProject[];
  } = {}
): {
  emit(): void;
  readonly ensureLoadedCalls: number;
  resetEnsureLoadedCalls(): void;
  service: NonNullable<
    WorkspaceFileManagerServiceDependencies["workspaceUserProjectService"]
  >;
} {
  const listeners = new Set<() => void>();
  let ensureLoadedCalls = 0;
  const projects = [...(input.projects ?? [])];
  let revision = 0;
  const fail = () => {
    throw new Error("Workspace user project stub method should not be called");
  };
  const service = {
    _serviceBrand: undefined,
    checkProjectPath: fail,
    createProject: fail,
    async ensureLoaded() {
      ensureLoadedCalls += 1;
    },
    getDefaultSelection: fail,
    getRevision() {
      return revision;
    },
    getSnapshot() {
      return {
        error: null,
        initialized: true,
        isLoading: false,
        projects: [...projects],
        revision
      };
    },
    isNoProjectPath: () => false,
    prepareSelection: fail,
    refresh: fail,
    registerProjectPath: fail,
    rememberDefaultSelection: fail,
    rememberNoProjectPath() {},
    removeProjectPath: fail,
    selectDirectory: fail,
    store: {
      error: null,
      initialized: true,
      isLoading: false,
      projects,
      revision
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  } as unknown as NonNullable<
    WorkspaceFileManagerServiceDependencies["workspaceUserProjectService"]
  >;

  return {
    emit() {
      revision += 1;
      for (const listener of listeners) {
        listener();
      }
    },
    get ensureLoadedCalls() {
      return ensureLoadedCalls;
    },
    resetEnsureLoadedCalls() {
      ensureLoadedCalls = 0;
    },
    service
  };
}

function createDependenciesStub(): {
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
} & Pick<
  WorkspaceFileManagerServiceDependencies,
  "reporterService" | "workspaceUserProjectService"
> {
  const fail = () => {
    throw new Error(
      "Desktop dependencies should not be called during session lookup"
    );
  };

  return {
    hostFilesApi: {
      createUserDocumentsProjectDirectory: fail,
      openExternal: fail,
      openFile: fail,
      listOpenWithApplications: async () => [],
      openFileWithApplication: fail,
      openFileWithOtherApplication: fail,
      openFileInBrowser: fail,
      resolveWorkspaceFileFileUrl: fail,
      revealInFolder: fail,
      revealWorkspaceFile: fail,
      openTerminalLink: fail,
      readLocalFileText: fail,
      readLocalPreviewFile: fail,
      readPreviewFile: fail,
      resolveEntryIcon: async () => null,
      selectAppArchive: fail,
      selectAppArchiveExportPath: fail,
      selectAppIconImage: fail,
      selectDirectory: fail,
      selectUploadFiles: fail,
      copyImageToClipboard: fail,
      copyFilesToClipboard: fail
    },
    tuttidClient: {
      listCliCapabilities: fail,
      listWorkspaceAppMentionCandidates: fail,
      addWorkspaceIssueContextRefs: fail,
      addWorkspaceIssueTaskContextRefs: fail,
      installWorkspaceApp: fail,
      exportWorkspaceApp: fail,
      importWorkspaceApp: fail,
      loadLocalWorkspaceApp: fail,
      replaceWorkspaceAppIcon: fail,
      reloadLocalWorkspaceApp: fail,
      cancelWorkspaceAppFactoryJob: fail,
      completeWorkspaceIssueTaskRun: fail,
      completeWorkspaceIssueRun: fail,
      createWorkspaceIssue: fail,
      createWorkspaceIssueTopic: fail,
      createWorkspaceIssueTask: fail,
      createWorkspaceIssueTasks: fail,
      createWorkspaceIssueTaskRun: fail,
      createWorkspaceIssueRun: fail,
      createWorkspace: fail,
      createWorkspaceAgentSession: fail,
      updateWorkspaceAgentSessionVisibility: fail,
      createWorkspaceAppFactoryJob: fail,
      createWorkspaceFile: fail,
      createWorkspaceFileDirectory: fail,
      readWorkspaceFilePreview: fail,
      writeWorkspaceFileText: fail,
      createWorkspaceTerminal: fail,
      deleteWorkspace: fail,
      deleteWorkspaceAgentSession: fail,
      clearWorkspaceAgentSessions: fail,
      deleteWorkspaceApp: fail,
      deleteWorkspaceAppFactoryJob: fail,
      deleteWorkspaceIssue: fail,
      deleteWorkspaceIssueTopic: fail,
      deleteWorkspaceIssueTask: fail,
      deleteWorkspaceFileEntry: fail,
      getDesktopPreferences: fail,
      getHealth: fail,
      getStartupWorkspace: fail,
      getWorkspace: fail,
      getWorkspaceAgentSession: fail,
      getWorkspaceAppFactoryJob: fail,
      getWorkspaceAppFactoryProviderComposerOptions: fail,
      getAgentProviderComposerOptions: fail,
      getAgentProviderStatuses: fail,
      probeAgentProvider: fail,
      runAgentProviderAction: fail,
      getWorkspaceIssueDetail: fail,
      searchWorkspaceIssueReferences: fail,
      getWorkspaceIssueTaskDetail: fail,
      getWorkspaceIssueTaskRun: fail,
      getWorkspaceIssueRun: fail,
      getWorkspaceTerminal: fail,
      getWorkspaceTerminalSnapshot: fail,
      getWorkspaceWorkbench: fail,
      getWorkspaceFileTreeSnapshot: fail,
      listWorkspaceFileDirectory: fail,
      listWorkspaceRecentFiles: fail,
      listWorkspaceAgentSessionMessages: fail,
      listWorkspaceAgentGeneratedFiles: fail,
      scanWorkspaceExternalAgentSessionImports: fail,
      importWorkspaceExternalAgentSessions: fail,
      listUserProjects: fail,
      deleteUserProject: fail,
      checkUserProjectPath: fail,
      listWorkspaceIssues: fail,
      listWorkspaceIssueTopics: fail,
      listWorkspaceIssueTaskRuns: fail,
      listWorkspaceIssueRuns: fail,
      listWorkspaceIssueTasks: fail,
      listWorkspaceAgentSessions: fail,
      listWorkspaceApps: fail,
      listWorkspaceAppReferences: fail,
      searchWorkspaceAppReferences: fail,
      prepareWorkspaceAppUpload: fail,
      completeWorkspaceAppUpload: fail,
      cancelWorkspaceAppUpload: fail,
      refreshWorkspaceAppCatalog: fail,
      listWorkspaceAppFactoryJobs: fail,
      listWorkspaceTerminals: fail,
      listWorkspaces: fail,
      launchWorkspaceApp: fail,
      moveWorkspaceFileEntry: fail,
      renameWorkspaceFileEntry: fail,
      copyWorkspaceFileEntry: fail,
      openWorkspace: fail,
      preflightUploadWorkspaceFiles: fail,
      putWorkspaceWorkbench: fail,
      checkWorkspaceTerminalCloseGuard: fail,
      uninstallWorkspaceApp: fail,
      removeWorkspaceIssueContextRef: fail,
      removeWorkspaceIssueTaskContextRef: fail,
      resizeWorkspaceTerminal: fail,
      retryWorkspaceApp: fail,
      retryWorkspaceAppFactoryJobValidation: fail,
      fixWorkspaceAppFactoryJob: fail,
      prepareWorkspaceAppFactoryJobModification: fail,
      publishWorkspaceAppFactoryJob: fail,
      rollbackWorkspaceApp: fail,
      cancelWorkspaceAgentSession: fail,
      cancelWorkspaceAgentSessionWithResult: fail,
      sendWorkspaceAgentSessionInput: fail,
      readWorkspaceAgentSessionAttachment: fail,
      listWorkspaceAgentSessionGitBranches: fail,
      listWorkspaceGitBranches: fail,
      updateWorkspaceAgentSessionSettings: fail,
      updateWorkspaceAgentSessionPin: fail,
      submitWorkspaceAgentInteractive: fail,
      searchWorkspaceFiles: fail,
      startEnabledWorkspaceApps: fail,
      stopAllWorkspaceApps: fail,
      putDesktopPreferences: fail,
      terminateWorkspaceTerminal: fail,
      trackEvents: async () => {},
      updateWorkspaceIssue: fail,
      updateWorkspaceIssueTopic: fail,
      updateWorkspaceIssueTask: fail,
      updateWorkspace: fail,
      uploadWorkspaceFiles: fail,
      useUserProject: fail
    },
    platformApi: {
      homeDirectory: "/Users/local",
      os: "darwin",
      resolveDroppedPaths: fail
    }
  };
}

function createReporterService(calls: ReporterEventInput[][] = []) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}

function createNotificationRecorder(): {
  items: Array<{
    description: string | undefined;
    title: string;
    tone: "error" | "info" | "success" | "warning";
  }>;
  service: NotificationService;
} {
  const items: Array<{
    description: string | undefined;
    title: string;
    tone: "error" | "info" | "success" | "warning";
  }> = [];
  return {
    items,
    service: {
      _serviceBrand: undefined,
      error(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: "error"
        });
      },
      info(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: "info"
        });
      },
      notify(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: input.level
        });
      },
      success(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: "success"
        });
      },
      warning(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: "warning"
        });
      }
    }
  };
}
