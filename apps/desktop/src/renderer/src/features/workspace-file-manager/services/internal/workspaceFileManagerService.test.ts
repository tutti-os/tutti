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
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { DesktopHostFilesApi, DesktopPlatformApi } from "@preload/types";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { applyLocale } from "../../../../i18n/runtime.ts";
import {
  WorkspaceFileManagerService,
  type WorkspaceFileManagerServiceDependencies
} from "./workspaceFileManagerService.ts";

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
      schemaVersion: 2
    };

    const first = service.getSession("workspace-1", copy, restoredState);
    const second = service.getSession("workspace-1", copy, {
      currentDirectoryPath: "/Users/demo/project/ignored",
      navigationBackStack: [],
      navigationForwardStack: [],
      schemaVersion: 2
    });

    assert.equal(first, second);
    assert.equal(first.store.currentDirectoryPath, "/Users/demo/project/docs");
    assert.equal(first.store.selectedPath, null);
    assert.deepEqual(service.getSnapshotState("workspace-1"), restoredState);
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
    schemaVersion: 2
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
          path: "/Users/demo/.tutti-dev/agent/runs/generated_images/image.png",
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
    "/Users/demo/.tutti-dev/agent/runs/generated_images/image.png"
  );

  assert.equal(capturedRequest?.includeHidden, true);
  assert.equal(
    capturedRequest?.path,
    "/Users/demo/.tutti-dev/agent/runs/generated_images"
  );
  assert.equal(
    session.store.selectedPath,
    "/Users/demo/.tutti-dev/agent/runs/generated_images/image.png"
  );
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

function createDependenciesStub(): {
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
} & Pick<WorkspaceFileManagerServiceDependencies, "reporterService"> {
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
      readPreviewFile: fail,
      resolveEntryIcon: async () => null,
      selectAppArchive: fail,
      selectAppArchiveExportPath: fail,
      selectAppIconImage: fail,
      selectDirectory: fail,
      selectUploadFiles: fail,
      copyFilesToClipboard: fail
    },
    tuttidClient: {
      listCliCapabilities: fail,
      addWorkspaceIssueContextRefs: fail,
      addWorkspaceIssueTaskContextRefs: fail,
      installWorkspaceApp: fail,
      exportWorkspaceApp: fail,
      importWorkspaceApp: fail,
      replaceWorkspaceAppIcon: fail,
      cancelWorkspaceAppFactoryJob: fail,
      completeWorkspaceIssueTaskRun: fail,
      completeWorkspaceIssueRun: fail,
      createWorkspaceIssue: fail,
      createWorkspaceIssueTopic: fail,
      createWorkspaceIssueTask: fail,
      createWorkspaceIssueTaskRun: fail,
      createWorkspaceIssueRun: fail,
      createWorkspace: fail,
      createWorkspaceAgentSession: fail,
      createWorkspaceAppFactoryJob: fail,
      createWorkspaceFile: fail,
      createWorkspaceFileDirectory: fail,
      readWorkspaceFilePreview: fail,
      writeWorkspaceFileText: fail,
      createWorkspaceTerminal: fail,
      deleteWorkspace: fail,
      deleteWorkspaceAgentSession: fail,
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
      getAgentProviderComposerOptions: fail,
      getAgentProviderStatuses: fail,
      probeAgentProvider: fail,
      runAgentProviderAction: fail,
      getWorkspaceIssueDetail: fail,
      getWorkspaceIssueTaskDetail: fail,
      getWorkspaceIssueTaskRun: fail,
      getWorkspaceIssueRun: fail,
      getWorkspaceTerminal: fail,
      getWorkspaceTerminalSnapshot: fail,
      getWorkspaceWorkbench: fail,
      getWorkspaceFileTreeSnapshot: fail,
      listWorkspaceFileDirectory: fail,
      listWorkspaceAgentSessionMessages: fail,
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
      refreshWorkspaceAppCatalog: fail,
      listWorkspaceAppFactoryJobs: fail,
      listWorkspaceTerminals: fail,
      listWorkspaces: fail,
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
