import assert from "node:assert/strict";
import test from "node:test";
import type { AgentGUIProps, AgentHostInputApi } from "@tutti-os/agent-gui";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { RichTextAtProvider } from "@tutti-os/ui-rich-text/types";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type { ReporterEventInput } from "@renderer/features/analytics/services/reporterService.interface.ts";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import { createDesktopAgentGUIWorkbenchHostInput } from "./createDesktopAgentGUIWorkbenchHostInput.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface.ts";

const workspaceId = "workspace-1";

test("desktop agent GUI workbench host input reuses an injected agent host api", () => {
  const agentHostApi = {
    meta: { workspaceId }
  } as unknown as AgentHostInputApi;
  const richTextAtProviders = [createRichTextAtProvider("workspace-file")];
  const richTextAtRequests: unknown[] = [];

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({
      providers: richTextAtProviders,
      requests: richTextAtRequests
    }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  assert.equal(hostInput.agentHostApi, agentHostApi);
  assert.equal(hostInput.richTextAtProviders, richTextAtProviders);
  assert.equal(
    typeof hostInput.workspaceFileReferenceAdapter.listDirectory,
    "function"
  );
  assert.deepEqual(richTextAtRequests, [
    {
      capabilities: [
        "workspace-file",
        "workspace-issue",
        "agent-session",
        "workspace-app"
      ],
      surface: "composer",
      target: "agent-gui",
      workspaceId
    }
  ]);
});

test("desktop agent GUI workbench host input creates the default agent host api", async () => {
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  assert.equal(hostInput.agentHostApi.meta?.workspaceId, workspaceId);
  assert.equal(
    typeof hostInput.agentHostApi.agentSessions?.getComposerOptions,
    "function"
  );
  assert.deepEqual(
    await hostInput.workspaceFileReferenceAdapter.listDirectory?.({
      workspaceId
    }),
    {
      directoryPath: "/workspace",
      entries: [],
      rootPath: "/workspace"
    }
  );
});

test("desktop agent GUI workbench host input passes an activity runtime backed by the workspace service", () => {
  const agentHostApi = {
    meta: { workspaceId }
  } as unknown as AgentHostInputApi;
  const calls: string[] = [];
  const workspaceAgentActivityService =
    createWorkspaceAgentActivityService(calls);

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService,
    workspaceId
  });

  assert.equal(hostInput.agentHostApi, agentHostApi);
  assert.notEqual(hostInput.agentActivityRuntime, null);
  assert.equal(
    hostInput.agentActivityRuntime?.getSnapshot(workspaceId).workspaceId,
    workspaceId
  );
  assert.deepEqual(calls, [`getSnapshot:${workspaceId}`]);
});

test("desktop agent GUI workbench host input tracks runtime prompt sends", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.sendInput({
    workspaceId,
    agentSessionId: "session-runtime-send-1",
    content: [
      {
        type: "text",
        text: "/review [src/App.tsx](mention://workspace-file?path=src%2FApp.tsx)"
      }
    ]
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.message_sent",
        params: {
          agent_session_id: "session-runtime-send-1",
          conversation_index: 1,
          has_file_mention: true,
          has_slash_command: true,
          is_queued: false,
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks workspace file references", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.trackWorkspaceFileReferences({
    provider: "codex",
    references: [
      {
        displayName: "README.md",
        kind: "file",
        path: "/workspace/README.md"
      },
      {
        displayName: "docs",
        kind: "folder",
        path: "/workspace/docs"
      }
    ]
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.workspace_file_referenced",
        params: {
          has_directory: true,
          provider: "codex",
          reference_count: 2
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks runtime message stops", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.cancelSession({
    workspaceId,
    agentSessionId: "session-runtime-stop-1"
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.message_stopped",
        params: {
          agent_session_id: "session-runtime-stop-1",
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input skips stopped tracking for no-op cancel", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([], {
      cancelSessionResult: {
        canceled: false,
        reason: "no_active_turn",
        session: {
          ...emptySession(),
          agentSessionId: "session-runtime-stop-1",
          status: "ready"
        }
      }
    }),
    workspaceId
  });

  await hostInput.agentActivityRuntime.cancelSession({
    workspaceId,
    agentSessionId: "session-runtime-stop-1"
  });

  assert.deepEqual(reporterCalls, []);
});

test("desktop agent GUI workbench host input tracks runtime new session activation", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.activateSession({
    workspaceId,
    agentSessionId: "session-runtime-start-1",
    cwd: "/workspace",
    mode: "new",
    provider: "codex",
    settings: {
      model: "gpt-5",
      permissionModeId: "auto"
    }
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.session_started",
        params: {
          agent_session_id: "session-runtime-start-1",
          has_custom_model: false,
          has_project: true,
          permission_mode: "auto",
          provider: "codex",
          source: "launchpad"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks runtime session pin changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.setSessionPinned({
    workspaceId,
    agentSessionId: "session-runtime-pin-1",
    pinned: true
  });
  await hostInput.agentActivityRuntime.setSessionPinned({
    workspaceId,
    agentSessionId: "session-runtime-pin-1",
    pinned: false
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.conversation_pinned",
        params: {
          agent_session_id: "session-runtime-pin-1",
          provider: "codex"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.conversation_unpinned",
        params: {
          agent_session_id: "session-runtime-pin-1",
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks runtime session settings changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const terminalDiagnostics: Array<
    Parameters<DesktopRuntimeApi["logTerminalDiagnostic"]>[0]
  > = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi({ terminalDiagnostics }),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([], {
      controlStateSettings: {
        model: "gpt-5",
        permissionModeId: "auto",
        reasoningEffort: "medium"
      }
    }),
    workspaceId
  });

  await hostInput.agentActivityRuntime.updateSessionSettings({
    workspaceId,
    agentSessionId: "session-runtime-settings-1",
    settings: {
      model: "custom:local-model",
      permissionModeId: "full-access",
      reasoningEffort: "high"
    }
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.model_changed",
        params: {
          agent_session_id: "session-runtime-settings-1",
          is_custom_model: true,
          provider: "codex"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.permission_mode_changed",
        params: {
          agent_session_id: "session-runtime-settings-1",
          from_mode: "auto",
          provider: "codex",
          to_mode: "full-access"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.reasoning_effort_changed",
        params: {
          agent_session_id: "session-runtime-settings-1",
          from_effort: "medium",
          provider: "codex",
          to_effort: "high"
        }
      }
    ]
  ]);
  assert.deepEqual(terminalDiagnostics, [
    {
      details: {
        agentSessionId: "session-runtime-settings-1",
        changedFields: "model,permissionModeId,reasoningEffort",
        modelFrom: "gpt-5",
        modelTo: "custom:local-model",
        permissionModeIdFrom: "auto",
        permissionModeIdTo: "full-access",
        provider: "codex",
        reasoningEffortFrom: "medium",
        reasoningEffortTo: "high",
        source: "session"
      },
      event: "agent.gui.composer_settings.changed",
      level: "info",
      sessionId: "session-runtime-settings-1",
      workspaceId
    }
  ]);
});

test("desktop agent GUI workbench host input tracks runtime project setting changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.trackSettingsProjectChange?.({
    workspaceId,
    agentSessionId: "session-runtime-project-1",
    action: "select_existing",
    provider: "codex"
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.project_changed",
        params: {
          action: "select_existing",
          agent_session_id: "session-runtime-project-1",
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks draft composer setting changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const terminalDiagnostics: Array<
    Parameters<DesktopRuntimeApi["logTerminalDiagnostic"]>[0]
  > = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi({ terminalDiagnostics }),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.trackDraftComposerSettingsChange?.({
    workspaceId,
    provider: "codex",
    previousSettings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "low"
    },
    nextSettings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "high"
    }
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.reasoning_effort_changed",
        params: {
          agent_session_id: null,
          from_effort: "low",
          provider: "codex",
          to_effort: "high"
        }
      }
    ]
  ]);
  assert.deepEqual(terminalDiagnostics, [
    {
      details: {
        agentSessionId: null,
        changedFields: "reasoningEffort",
        provider: "codex",
        reasoningEffortFrom: "low",
        reasoningEffortTo: "high",
        source: "draft"
      },
      event: "agent.gui.composer_settings.changed",
      level: "info",
      sessionId: undefined,
      workspaceId
    }
  ]);
});

test("desktop agent GUI workbench host input wires runtime control-state reads through the workspace activity service", async () => {
  const calls: string[] = [];
  const workspaceAgentActivityService =
    createWorkspaceAgentActivityService(calls);

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService,
    workspaceId
  });

  assert.deepEqual(
    await hostInput.agentActivityRuntime.getSessionControlState({
      workspaceId,
      agentSessionId: "session-1"
    }),
    {
      workspaceId,
      agentSessionId: "session-1",
      provider: "codex",
      status: "ready",
      updatedAtUnixMs: 1
    }
  );
  assert.deepEqual(calls, ["getSessionControlState:workspace-1:session-1"]);
});

test("desktop agent GUI workbench host input wires runtime composer options through the workspace activity service", async () => {
  const calls: string[] = [];
  const workspaceAgentActivityService =
    createWorkspaceAgentActivityService(calls);

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService,
    workspaceId
  });

  assert.deepEqual(
    await hostInput.agentActivityRuntime.getComposerOptions({
      workspaceId,
      provider: "codex",
      settings: { model: "gpt-5" }
    }),
    {
      provider: "codex",
      effectiveSettings: { model: "gpt-5" }
    }
  );
  assert.deepEqual(calls, ["getComposerOptions:workspace-1:codex"]);
});

test("desktop agent GUI workbench host input wires runtime activation through the workspace activity service", async () => {
  const calls: string[] = [];
  const workspaceAgentActivityService =
    createWorkspaceAgentActivityService(calls);

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService,
    workspaceId
  });

  assert.deepEqual(
    await hostInput.agentActivityRuntime.activateSession({
      workspaceId,
      agentSessionId: "session-1",
      mode: "existing"
    }),
    {
      activation: { mode: "existing", status: "already_attached" },
      session: {
        agentSessionId: "session-1",
        createdAtUnixMs: 1,
        cwd: "/workspace",
        provider: "codex",
        providerSessionId: "session-1",
        resumable: false,
        status: "ready",
        updatedAtUnixMs: 1,
        workspaceId
      }
    }
  );
  assert.deepEqual(calls, ["activateSession:workspace-1:session-1:existing"]);
});

test("desktop agent GUI workbench host input forwards OpenClaw warmup through the runtime", async () => {
  const warmupOpenclawGateway = async () => ({
    accepted: true,
    ready: true
  });
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId },
      runtime: {
        warmupOpenclawGateway
      }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  assert.deepEqual(
    await hostInput.agentActivityRuntime.warmupOpenclawGateway?.({
      workspaceId
    }),
    {
      accepted: true,
      ready: true
    }
  );
});

function createRichTextAtProvider(id: string): RichTextAtProvider {
  return {
    id,
    getItemKey: () => "item-1",
    getItemLabel: () => "Item",
    query: () => [],
    toInsertResult: () => ({ kind: "text", text: "Item" })
  };
}

function createRichTextAtService(
  input: {
    providers?: NonNullable<AgentGUIProps["richTextAtProviders"]>;
    requests?: unknown[];
  } = {}
): IDesktopRichTextAtService {
  return {
    _serviceBrand: undefined,
    getProviders(request) {
      input.requests?.push(request);
      return input.providers ?? [];
    }
  };
}

function createHostFilesApi(): DesktopHostFilesApi {
  return {
    async createUserDocumentsProjectDirectory(input) {
      return { path: `/Users/local/Documents/tutti/${input.name}` };
    },
    async openExternal() {},
    async openFile() {},
    async revealInFolder() {},
    async revealWorkspaceFile() {},
    async openTerminalLink() {},
    async readLocalFileText(path) {
      return { content: "", name: "", path };
    },
    async readPreviewFile() {
      return new Uint8Array();
    },
    async selectAppArchive() {
      return null;
    },
    async selectAppArchiveExportPath() {
      return null;
    },
    async selectAppIconImage() {
      return null;
    },
    async selectDirectory() {
      return null;
    },
    async selectUploadFiles() {
      return [];
    },
    async copyFilesToClipboard() {},
    async listOpenWithApplications() {
      return [];
    },
    async openFileWithApplication() {},
    async openFileWithOtherApplication() {},
    async openFileInBrowser() {},
    async resolveWorkspaceFileFileUrl() {
      return "file:///tmp/example.html";
    },
    async resolveEntryIcon() {
      return null;
    }
  };
}

function createTuttidClient(): TuttidClient {
  return {
    async checkUserProjectPath(
      request: Parameters<TuttidClient["checkUserProjectPath"]>[0]
    ) {
      return {
        exists: true,
        isDirectory: true,
        path: request.path
      };
    },
    async getAgentProviderComposerOptions(
      provider: Parameters<TuttidClient["getAgentProviderComposerOptions"]>[0],
      request: Parameters<TuttidClient["getAgentProviderComposerOptions"]>[1]
    ) {
      const settings = request?.settings ?? {};
      return {
        effectiveSettings: settings,
        modelConfig: {
          configurable: true,
          currentValue: settings.model ?? undefined,
          defaultValue: settings.model ?? undefined,
          options: settings.model
            ? [
                {
                  id: settings.model,
                  label: settings.model,
                  value: settings.model
                }
              ]
            : []
        },
        permissionConfig: {
          configurable: true,
          defaultValue: settings.permissionModeId ?? undefined,
          modes: settings.permissionModeId
            ? [
                {
                  id: settings.permissionModeId,
                  label: settings.permissionModeId,
                  semantic: "auto"
                }
              ]
            : []
        },
        provider,
        reasoningConfig: {
          configurable: true,
          currentValue: settings.reasoningEffort ?? undefined,
          defaultValue: settings.reasoningEffort ?? undefined,
          options: settings.reasoningEffort
            ? [
                {
                  id: settings.reasoningEffort,
                  label: settings.reasoningEffort,
                  value: settings.reasoningEffort
                }
              ]
            : []
        },
        runtimeContext: {},
        skills: []
      };
    },
    async getWorkspaceFileTreeSnapshot() {
      return {
        budgetExceeded: false,
        directory: {
          directoryPath: "/workspace",
          entries: [],
          prefetchState: "loaded"
        },
        prefetchBudgetMs: 500,
        prefetchDepth: 4,
        root: "/workspace"
      };
    },
    async listWorkspaceFileDirectory() {
      return {
        directoryPath: "/workspace",
        entries: [],
        root: "/workspace",
        workspaceId
      };
    },
    async listUserProjects() {
      return { projects: [] };
    },
    async useUserProject(
      request: Parameters<TuttidClient["useUserProject"]>[0]
    ) {
      return {
        createdAtUnixMs: 1,
        id: "project-1",
        label: "Project",
        path: request.path,
        updatedAtUnixMs: 1
      };
    },
    async writeWorkspaceFileText(
      workspaceId: string,
      request: Parameters<TuttidClient["writeWorkspaceFileText"]>[1]
    ) {
      return {
        entry: {
          hasChildren: false,
          kind: "file",
          mtimeMs: null,
          name: request.path.split("/").filter(Boolean).at(-1) ?? "",
          path: request.path,
          sizeBytes: request.content.length
        },
        root: "/workspace",
        workspaceId
      };
    }
  } as unknown as TuttidClient;
}

function createPlatformApi(): Pick<
  DesktopPlatformApi,
  "homeDirectory" | "os" | "resolveDroppedPaths"
> {
  return {
    homeDirectory: "/Users/local",
    os: "darwin",
    resolveDroppedPaths() {
      return [];
    }
  };
}

function createRuntimeApi(
  input: {
    terminalDiagnostics?: Array<
      Parameters<DesktopRuntimeApi["logTerminalDiagnostic"]>[0]
    >;
  } = {}
): DesktopRuntimeApi {
  return {
    async getBackendConfig() {
      return {
        accessToken: "token-1",
        baseUrl: "http://127.0.0.1:4000"
      };
    },
    async getBusinessEventStreamUrl() {
      return "ws://127.0.0.1:4000/v1/events/ws?access_token=token-1";
    },
    async listWorkspaceAgentProbes(probeInput) {
      return {
        capturedAtUnixMs: 1,
        providers: [],
        workspaceId: probeInput.workspaceId
      };
    },
    async getTerminalStreamUrl(input) {
      return `ws://127.0.0.1:4000/${input.workspaceId}/${input.sessionId}`;
    },
    async logRendererDiagnostic() {},
    async logTerminalDiagnostic(payload) {
      input.terminalDiagnostics?.push(payload);
    }
  };
}

function createWorkspaceAgentActivityService(
  calls: string[],
  options: {
    cancelSessionResult?: Awaited<
      ReturnType<IWorkspaceAgentActivityService["cancelSession"]>
    >;
    controlStateSettings?: {
      model?: string | null;
      permissionModeId?: string | null;
      reasoningEffort?: string | null;
    };
  } = {}
): IWorkspaceAgentActivityService {
  const snapshot: AgentActivitySnapshot = {
    workspaceId,
    presences: [],
    sessions: [],
    sessionMessagesById: {}
  };
  return {
    _serviceBrand: undefined,
    async activateSession(input) {
      calls.push(
        `activateSession:${input.workspaceId}:${input.agentSessionId}:${input.mode}`
      );
      return {
        activation: {
          mode: input.mode,
          status: input.mode === "existing" ? "already_attached" : "attached"
        },
        session: {
          agentSessionId: input.agentSessionId,
          createdAtUnixMs: 1,
          workspaceId: input.workspaceId,
          provider: "codex",
          providerSessionId: input.agentSessionId,
          status: "ready",
          resumable: false,
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      };
    },
    async cancelSession(input) {
      if (options.cancelSessionResult) {
        return {
          ...options.cancelSessionResult,
          session: {
            ...options.cancelSessionResult.session,
            agentSessionId: input.agentSessionId
          }
        };
      }
      return {
        canceled: true,
        reason: "active_turn_canceled",
        session: {
          ...emptySession(),
          agentSessionId: input.agentSessionId,
          status: "canceled"
        }
      };
    },
    async createSession(input) {
      return {
        ...emptySession(),
        agentSessionId: input.agentSessionId ?? "session-1",
        provider: input.provider
      };
    },
    async deleteSession() {
      return { removed: true };
    },
    async getComposerOptions(input) {
      calls.push(
        `getComposerOptions:${input.workspaceId}:${input.provider ?? ""}`
      );
      return {
        effectiveSettings: input.settings ?? {},
        provider: input.provider ?? "codex"
      };
    },
    async updateSessionSettings(input) {
      calls.push(
        `updateSessionSettings:${input.workspaceId}:${input.agentSessionId}`
      );
      return {
        agentSessionId: input.agentSessionId,
        settings: input.settings
      };
    },
    async getSession(_workspaceId, agentSessionId) {
      return { ...emptySession(), agentSessionId };
    },
    async getSessionControlState(input) {
      calls.push(
        `getSessionControlState:${input.workspaceId}:${input.agentSessionId}`
      );
      return {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        provider: "codex",
        ...(options.controlStateSettings
          ? { settings: options.controlStateSettings }
          : {}),
        status: "ready",
        updatedAtUnixMs: 1
      };
    },
    getSnapshot(inputWorkspaceId) {
      calls.push(`getSnapshot:${inputWorkspaceId}`);
      return { ...snapshot, workspaceId: inputWorkspaceId };
    },
    async listSessionMessages() {
      return { messages: [], hasMore: false, latestVersion: 0 };
    },
    async load(inputWorkspaceId) {
      return { ...snapshot, workspaceId: inputWorkspaceId };
    },
    onSessionEvent() {
      return () => {};
    },
    ensureSessionSynchronized() {
      return () => {};
    },
    retainSessionEvents() {
      return () => {};
    },
    async sendInput(input) {
      return {
        ...emptySession(),
        agentSessionId: input.agentSessionId,
        status: "working"
      };
    },
    async readSessionAttachment(input) {
      return {
        attachmentId: input.attachmentId,
        mimeType: "image/png",
        data: ""
      };
    },
    async setSessionPinned(input) {
      return {
        ...emptySession(),
        agentSessionId: input.agentSessionId,
        pinnedAtUnixMs: input.pinned ? 1 : null
      };
    },
    async submitInteractive() {
      return {};
    },
    subscribe() {
      return () => {};
    },
    async unactivateSession(input) {
      calls.push(
        `unactivateSession:${input.workspaceId}:${input.agentSessionId}`
      );
      return {
        agentSessionId: input.agentSessionId,
        buffered: false
      };
    }
  };
}

function emptySession(): AgentActivitySnapshot["sessions"][number] {
  return {
    workspaceId,
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/workspace",
    title: "Session",
    status: "working",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1
  };
}
