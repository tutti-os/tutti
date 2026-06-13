import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceAgentSession
} from "@tutti-os/client-tuttid-ts";
import type { AgentPromptContentBlock } from "@tutti-os/agent-activity-core";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type {
  DesktopTerminalDiagnosticPayload,
  DesktopTerminalStreamUrlRequest
} from "@shared/contracts/ipc";
import type { ReporterEventInput } from "../../analytics/services/reporterService.interface.ts";
import { createDesktopAgentHostApi } from "./createDesktopAgentHostApi.ts";
import { WorkspaceAgentActivityService } from "./internal/workspaceAgentActivityService.ts";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";

const workspaceId = "workspace-1";

interface DesktopAgentHostApiUnderTest {
  agentGuiBatch: {
    exportRun(input: unknown): Promise<unknown>;
  };
  userProjects: {
    checkPath(input: { path: string }): Promise<{
      exists: boolean;
      isDirectory: boolean;
      path: string;
    }>;
    create(input: { name: string }): Promise<{
      id: string;
      label: string;
      path: string;
    }>;
    getDefaultSelection(): Promise<{ path: string | null } | null>;
    isNoProjectPath(input: { path: string }): boolean;
    list(): Promise<{
      projects: Array<{
        id: string;
        label: string;
        path: string;
      }>;
    }>;
    subscribe(listener: () => void): () => void;
    prepareSelection(input: {
      projectLocked: boolean;
      selectedPath: string | null;
    }): Promise<{
      isSelectedPathMissing: boolean;
      projects: Array<{
        id: string;
        label: string;
        path: string;
      }>;
      selection:
        | {
            kind: "clear";
            suppressedPath: string;
          }
        | {
            kind: "none";
          }
        | {
            kind: "select";
            path: string;
          };
    }>;
    rememberDefaultSelection(input: { path: string | null }): Promise<void>;
    remove(input: { path: string }): Promise<void>;
    use(input: { path: string }): Promise<{
      id: string;
      label: string;
      path: string;
    }>;
  };
  filesystem: {
    readFileText(input: {
      path?: string;
      uri?: string;
    }): Promise<{ content: string; name?: string; path?: string }>;
  };
  agentSessions: {
    activate(input: {
      agentSessionId: string;
      cwd?: string;
      initialContent?: AgentPromptContentBlock[];
      mode: "existing" | "new";
      provider?: string;
      settings?: {
        model?: string | null;
        permissionModeId?: string | null;
        planMode?: boolean | null;
        reasoningEffort?: string | null;
      };
      title?: string;
      visible?: boolean;
    }): Promise<{
      activation: { status: string };
      error?: { code: string; debugMessage: string; message: string };
      session: {
        agentSessionId: string;
        cwd?: string;
        providerSessionId?: string;
        resumable?: boolean;
        status?: string;
      };
    }>;
    cancel(input: { agentSessionId: string }): Promise<{
      agentSessionId?: string;
      canceled: boolean;
      reason?: string;
      sessionStatus?: string;
    }>;
    exec(input: {
      agentSessionId: string;
      content: AgentPromptContentBlock[];
    }): Promise<{ status: string }>;
    getState(input: { agentSessionId: string }): Promise<{
      agentSessionId: string;
      resumable?: boolean;
      runtimeContext?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    }>;
    getComposerOptions(input: {
      provider?: string;
      settings?: Record<string, unknown>;
    }): Promise<{
      provider?: string;
      models: Array<{ value: string; label: string; description?: string }>;
      reasoningEfforts: Array<{
        value: string;
        label: string;
        description?: string;
      }>;
      permissionConfig?: {
        configurable: boolean;
        modes: Array<{
          id: string;
          label?: string;
          description?: string;
          semantic?: string;
        }>;
      } | null;
      skills: Array<{
        name: string;
        trigger: string;
        sourceKind: string;
        description?: string;
        pluginName?: string;
      }>;
    }>;
    onEvent(listener: (event: unknown) => void): () => void;
    pinSession(input: { agentSessionId: string; pinned: boolean }): Promise<{
      agentSessionId: string;
      pinnedAtUnixMs?: number | null;
      workspaceId: string;
    }>;
    submitInteractive(input: {
      action?: string;
      agentSessionId: string;
      optionId?: string;
      payload?: Record<string, unknown>;
      requestId: string;
    }): Promise<{ accepted: boolean }>;
    updateSettings(input: {
      agentSessionId: string;
      settings: {
        model?: string | null;
        permissionModeId?: string | null;
        reasoningEffort?: string | null;
      };
    }): Promise<{
      agentSessionId: string;
      settings: Record<string, unknown>;
    }>;
    trackSettingsProjectChange?(input: {
      action: "clear" | "create_new" | "select_existing";
      agentSessionId: string;
      provider?: string | null;
    }): Promise<void>;
    subscribeEvents(
      input: { agentSessionId: string },
      listener: (event: unknown) => void
    ): () => void;
    unactivate(input: {
      agentSessionId: string;
    }): Promise<{ agentSessionId: string; buffered: boolean }>;
  };
  workspaceAgents: {
    deleteSession(input: {
      agentSessionId: string;
    }): Promise<{ removed?: boolean }>;
    list(): Promise<{
      sessionMessagesById: Record<string, Array<{ messageId: string }>>;
      sessions: Array<{
        agentSessionId: string;
        providerSessionId?: string;
        resumable?: boolean;
        sessionOrigin?: string;
        turnPhase?: string;
      }>;
    }>;
    listSessionMessages(input: {
      afterVersion?: number;
      agentSessionId: string;
      limit?: number;
    }): Promise<{
      hasMore?: boolean;
      latestVersion?: number;
      messages: Array<{
        agentSessionId?: string;
        messageId: string;
        payload: Record<string, unknown>;
        version: number;
      }>;
    }>;
  };
  workspace: {
    getPathForFile(file: File): string;
    readFile(input: {
      path: string;
    }): Promise<{ content: string; path: string }>;
    selectDirectory(): Promise<{ path: string } | null>;
    selectFiles(): Promise<Array<{ path: string }>>;
    writeFileText(input: { content: string; path: string }): Promise<void>;
  };
}

test("desktop agent host api routes session commands through injected tuttid client", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async cancelWorkspaceAgentSessionWithResult(
        requestWorkspaceId: string,
        agentSessionId: string
      ) {
        calls.push({
          args: [requestWorkspaceId, agentSessionId],
          method: "cancel"
        });
        return {
          cancel: {
            canceled: true,
            reason: "active_turn_canceled"
          },
          session: createSession({ id: agentSessionId, status: "canceled" })
        };
      },
      async createWorkspaceAgentSession(
        requestWorkspaceId: string,
        request: { agentSessionId: string }
      ) {
        calls.push({
          args: [requestWorkspaceId, request],
          method: "create"
        });
        return createSession({
          id: request.agentSessionId,
          status: "created"
        });
      },
      async getWorkspaceAgentSession(
        requestWorkspaceId: string,
        agentSessionId: string
      ) {
        calls.push({
          args: [requestWorkspaceId, agentSessionId],
          method: "get"
        });
        return createSession({ id: agentSessionId, status: "running" });
      },
      async submitWorkspaceAgentInteractive(
        requestWorkspaceId: string,
        agentSessionId: string,
        requestId: string,
        request: unknown
      ) {
        calls.push({
          args: [requestWorkspaceId, agentSessionId, requestId, request],
          method: "interactive"
        });
        return createSession({ id: agentSessionId, status: "waiting" });
      },
      async sendWorkspaceAgentSessionInput(
        requestWorkspaceId: string,
        agentSessionId: string,
        request: unknown
      ) {
        calls.push({
          args: [requestWorkspaceId, agentSessionId, request],
          method: "input"
        });
        return createSession({ id: agentSessionId, status: "running" });
      }
    })
  });

  const created = await api.agentSessions.activate({
    agentSessionId: "11111111-1111-4111-8111-111111111111",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "Build" }],
    mode: "new",
    settings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "high"
    },
    title: "Build"
  });
  const existing = await api.agentSessions.activate({
    agentSessionId: "existing-session",
    mode: "existing"
  });
  const createdAgentSessionId = created.session.agentSessionId;
  const input = await api.agentSessions.exec({
    agentSessionId: createdAgentSessionId,
    content: [{ type: "text", text: "continue" }]
  });
  const permission = await api.agentSessions.submitInteractive({
    agentSessionId: createdAgentSessionId,
    optionId: "approve",
    requestId: "permission-1"
  });
  const deniedPermission = await api.agentSessions.submitInteractive({
    action: "deny",
    agentSessionId: createdAgentSessionId,
    optionId: "abort",
    payload: { denyMessage: "Please split the work into smaller steps." },
    requestId: "permission-2"
  });
  const interactive = await api.agentSessions.submitInteractive({
    agentSessionId: createdAgentSessionId,
    optionId: "acceptEdits",
    payload: { path: "/Users/example/demo/src/styles.css" },
    requestId: "interactive-1"
  });
  const abortInteractive = await api.agentSessions.submitInteractive({
    action: "deny",
    agentSessionId: createdAgentSessionId,
    optionId: "abort",
    payload: { denyMessage: "Please split the work into smaller steps." },
    requestId: "interactive-2"
  });
  const canceled = await api.agentSessions.cancel({
    agentSessionId: createdAgentSessionId
  });

  assert.equal(
    created.session.agentSessionId,
    "11111111-1111-4111-8111-111111111111"
  );
  assert.equal(
    created.session.providerSessionId,
    "11111111-1111-4111-8111-111111111111"
  );
  assert.equal(existing.session.agentSessionId, "existing-session");
  assert.equal(input.status, "started");
  assert.equal(permission.accepted, true);
  assert.equal(deniedPermission.accepted, true);
  assert.equal(interactive.accepted, true);
  assert.equal(abortInteractive.accepted, true);
  assert.equal(canceled.canceled, true);
  assert.equal(canceled.reason, "active_turn_canceled");
  assert.equal(canceled.sessionStatus, "canceled");
  assert.deepEqual(calls, [
    {
      args: [
        workspaceId,
        {
          agentSessionId: "11111111-1111-4111-8111-111111111111",
          cwd: "/workspace",
          initialContent: [{ type: "text", text: "Build" }],
          model: "gpt-5",
          permissionModeId: "auto",
          planMode: false,
          provider: "codex",
          reasoningEffort: "high",
          title: "Build",
          visible: true
        }
      ],
      method: "create"
    },
    {
      args: [workspaceId, "existing-session"],
      method: "get"
    },
    {
      args: [
        workspaceId,
        "11111111-1111-4111-8111-111111111111",
        { content: [{ type: "text", text: "continue" }] }
      ],
      method: "input"
    },
    {
      args: [
        workspaceId,
        "11111111-1111-4111-8111-111111111111",
        "permission-1",
        {
          action: null,
          optionId: "approve",
          payload: null
        }
      ],
      method: "interactive"
    },
    {
      args: [
        workspaceId,
        "11111111-1111-4111-8111-111111111111",
        "permission-2",
        {
          action: "deny",
          optionId: "abort",
          payload: { denyMessage: "Please split the work into smaller steps." }
        }
      ],
      method: "interactive"
    },
    {
      args: [
        workspaceId,
        "11111111-1111-4111-8111-111111111111",
        "interactive-1",
        {
          action: null,
          optionId: "acceptEdits",
          payload: { path: "/Users/example/demo/src/styles.css" }
        }
      ],
      method: "interactive"
    },
    {
      args: [
        workspaceId,
        "11111111-1111-4111-8111-111111111111",
        "interactive-2",
        {
          action: "deny",
          optionId: "abort",
          payload: { denyMessage: "Please split the work into smaller steps." }
        }
      ],
      method: "interactive"
    },
    {
      args: [workspaceId, "11111111-1111-4111-8111-111111111111"],
      method: "cancel"
    }
  ]);
});

test("desktop agent host api returns no-active-turn cancel metadata", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async cancelWorkspaceAgentSessionWithResult(
        _requestWorkspaceId: string,
        agentSessionId: string
      ) {
        return {
          cancel: {
            canceled: false,
            reason: "no_active_turn"
          },
          session: createSession({
            id: agentSessionId,
            status: "created"
          })
        };
      }
    }),
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    }
  });

  const result = await api.agentSessions.cancel({
    agentSessionId: "agent-session-1"
  });

  assert.deepEqual(result, {
    agentSessionId: "agent-session-1",
    canceled: false,
    reason: "no_active_turn",
    sessionStatus: "ready"
  });
  assert.deepEqual(reporterCalls, []);
});

test("desktop agent host api pins sessions through the canonical pinSession host method", async () => {
  const calls: unknown[] = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async updateWorkspaceAgentSessionPin(
        requestWorkspaceId: string,
        agentSessionId: string,
        request: Parameters<TuttidClient["updateWorkspaceAgentSessionPin"]>[2]
      ) {
        calls.push([requestWorkspaceId, agentSessionId, request]);
        return createSession({
          id: agentSessionId,
          pinnedAtUnixMs: request.pinned ? 1700000000000 : null
        });
      }
    })
  });

  const pinned = await api.agentSessions.pinSession({
    agentSessionId: "session-pin-1",
    pinned: true
  });
  const unpinned = await api.agentSessions.pinSession({
    agentSessionId: "session-pin-1",
    pinned: false
  });

  assert.equal(pinned.agentSessionId, "session-pin-1");
  assert.equal(pinned.workspaceId, workspaceId);
  assert.equal(pinned.pinnedAtUnixMs, 1700000000000);
  assert.equal(unpinned.pinnedAtUnixMs, null);
  assert.deepEqual(calls, [
    [workspaceId, "session-pin-1", { pinned: true }],
    [workspaceId, "session-pin-1", { pinned: false }]
  ]);
});

test("desktop agent host api tracks agent session lifecycle events", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(
        _workspaceId,
        request: Parameters<TuttidClient["createWorkspaceAgentSession"]>[1]
      ) {
        return createSession({
          cwd: request.cwd,
          id: request.agentSessionId,
          provider: request.provider,
          settings: {
            permissionModeId: requestPermissionModeValue(request)
          }
        });
      }
    }),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    }
  });

  await api.agentSessions.activate({
    agentSessionId: "session-track-1",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "Track session" }],
    mode: "new",
    provider: "codex",
    settings: {
      permissionModeId: "auto"
    }
  });
  await api.agentSessions.exec({
    agentSessionId: "session-track-1",
    content: [
      {
        type: "text",
        text: "/review [src/App.tsx](mention://workspace-file?path=src%2FApp.tsx)"
      }
    ]
  });
  await api.agentSessions.cancel({
    agentSessionId: "session-track-1"
  });
  await api.agentSessions.pinSession({
    agentSessionId: "session-track-1",
    pinned: true
  });
  await api.agentSessions.pinSession({
    agentSessionId: "session-track-1",
    pinned: false
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.session_started",
        params: {
          agent_session_id: "session-track-1",
          has_custom_model: false,
          has_project: true,
          permission_mode: "auto",
          provider: "codex",
          source: "launchpad"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.message_sent",
        params: {
          agent_session_id: "session-track-1",
          conversation_index: 1,
          has_file_mention: true,
          has_slash_command: true,
          is_queued: false,
          provider: "codex"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.message_stopped",
        params: {
          agent_session_id: "agent-session-1",
          provider: "codex"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.conversation_pinned",
        params: {
          agent_session_id: "session-track-1",
          provider: "codex"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.conversation_unpinned",
        params: {
          agent_session_id: "session-track-1",
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent host api tracks agent session settings changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(
        _workspaceId,
        request: Parameters<TuttidClient["createWorkspaceAgentSession"]>[1]
      ) {
        return createSession({
          id: request.agentSessionId,
          provider: request.provider,
          settings: {
            model: request.model ?? null,
            permissionModeId: requestPermissionModeValue(request),
            reasoningEffort: request.reasoningEffort ?? null
          }
        });
      },
      async updateWorkspaceAgentSessionSettings(
        _workspaceId,
        agentSessionId,
        settings: Parameters<
          TuttidClient["updateWorkspaceAgentSessionSettings"]
        >[2]
      ) {
        return createSession({
          id: agentSessionId,
          provider: "codex",
          settings
        });
      }
    }),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    }
  });

  await api.agentSessions.activate({
    agentSessionId: "session-settings-1",
    cwd: "/workspace",
    mode: "new",
    provider: "codex",
    settings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "medium"
    }
  });
  reporterCalls.length = 0;

  await api.agentSessions.updateSettings({
    agentSessionId: "session-settings-1",
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
          agent_session_id: "session-settings-1",
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
          agent_session_id: "session-settings-1",
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
          agent_session_id: "session-settings-1",
          from_effort: "medium",
          provider: "codex",
          to_effort: "high"
        }
      }
    ]
  ]);
});

test("desktop agent host api tracks agent project setting changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const api = createAgentHostApi({
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    }
  });

  await api.agentSessions.trackSettingsProjectChange?.({
    action: "select_existing",
    agentSessionId: "session-project-1",
    provider: "codex"
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.project_changed",
        params: {
          action: "select_existing",
          agent_session_id: "session-project-1",
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent host api deletes workspace agent sessions through tuttid", async () => {
  const calls: unknown[] = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async deleteWorkspaceAgentSession(
        requestWorkspaceId: string,
        agentSessionId: string
      ) {
        calls.push([requestWorkspaceId, agentSessionId]);
        return { removed: true };
      }
    })
  });

  const result = await api.workspaceAgents.deleteSession({
    agentSessionId: " agent-session-1 "
  });

  assert.deepEqual(result, { removed: true });
  assert.deepEqual(calls, [[workspaceId, "agent-session-1"]]);
});

test("desktop agent host api passes supported session providers", async () => {
  const calls: unknown[] = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, request) {
        calls.push(request);
        return createSession({
          id: request.agentSessionId,
          status: "created"
        });
      }
    })
  });

  await api.agentSessions.activate({
    agentSessionId: "22222222-2222-4222-8222-222222222222",
    cwd: "/workspace",
    mode: "new",
    provider: "claude-code",
    title: "Build"
  });

  assert.equal(
    (calls[0] as { provider?: unknown } | undefined)?.provider,
    "claude-code"
  );
});

test("desktop agent host api passes plan mode to new session creation", async () => {
  const calls: unknown[] = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, request) {
        calls.push(request);
        return createSession({
          id: request.agentSessionId,
          status: "created"
        });
      }
    })
  });

  await api.agentSessions.activate({
    agentSessionId: "33333333-3333-4333-8333-333333333333",
    cwd: "/workspace",
    mode: "new",
    provider: "codex",
    settings: {
      model: "gpt-5.5-codex-spark",
      permissionModeId: "read-only",
      planMode: true,
      reasoningEffort: "high"
    },
    title: "Plan"
  });

  assert.equal(
    (calls[0] as { planMode?: unknown } | undefined)?.planMode,
    true
  );
});

test("desktop agent host api rejects unknown session providers", async () => {
  let createCalled = false;
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession() {
        createCalled = true;
        return createSession({ id: "created-session", status: "created" });
      }
    })
  });

  await assert.rejects(
    () =>
      api.agentSessions.activate({
        agentSessionId: "unknown-session",
        cwd: "/workspace",
        mode: "new",
        provider: "unknown-agent",
        title: "Build"
      }),
    (error) => {
      assert.equal(
        (error as { code?: string }).code,
        "agent.provider_unsupported"
      );
      assert.match(
        (error as { debugMessage?: string }).debugMessage ?? "",
        /unknown-agent/
      );
      return true;
    }
  );
  assert.equal(createCalled, false);
});

test("desktop agent host api loads composer options through tuttid without creating a session", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, _request) {
        calls.push({ args: [_workspaceId, _request], method: "create" });
        return createSession({ id: "created-session", status: "created" });
      },
      async getAgentProviderComposerOptions(provider, request) {
        calls.push({ args: [provider, request], method: "options" });
        return {
          provider,
          modelConfig: {
            configurable: true,
            currentValue: request?.settings?.model ?? undefined,
            defaultValue: request?.settings?.model ?? undefined,
            options: request?.settings?.model
              ? [
                  {
                    id: request.settings.model,
                    label: request.settings.model,
                    value: request.settings.model
                  }
                ]
              : []
          },
          permissionConfig: {
            configurable: true,
            defaultValue: "auto",
            modes: [
              {
                id: "auto",
                label: "Approve for me",
                semantic: "auto"
              }
            ]
          },
          effectiveSettings: request?.settings ?? {},
          reasoningConfig: {
            configurable: true,
            currentValue: request?.settings?.reasoningEffort ?? undefined,
            defaultValue: request?.settings?.reasoningEffort ?? undefined,
            options: request?.settings?.reasoningEffort
              ? [
                  {
                    id: request.settings.reasoningEffort,
                    label: request.settings.reasoningEffort,
                    value: request.settings.reasoningEffort
                  }
                ]
              : []
          },
          runtimeContext: {
            configOptions: [
              {
                currentValue: "gpt-5",
                id: "model",
                options: [{ name: "GPT-5", value: "gpt-5" }]
              }
            ]
          },
          skills: []
        };
      }
    })
  });

  const options = await api.agentSessions.getComposerOptions({
    provider: "codex",
    settings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "high"
    }
  });

  assert.deepEqual(options.models, [{ value: "gpt-5", label: "gpt-5" }]);
  assert.deepEqual(options.reasoningEfforts, [
    { value: "high", label: "high" }
  ]);
  assert.deepEqual(options.permissionConfig, {
    configurable: true,
    defaultValue: "auto",
    modes: [
      {
        id: "auto",
        label: "Approve for me",
        semantic: "auto"
      }
    ]
  });
  assert.deepEqual(calls, [
    {
      args: [
        "codex",
        {
          settings: {
            model: "gpt-5",
            permissionModeId: "auto",
            planMode: false,
            reasoningEffort: "high"
          }
        }
      ],
      method: "options"
    }
  ]);
});

test("desktop agent host api exposes persisted session composer options", async () => {
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async getWorkspaceAgentSession(_workspaceId, agentSessionId) {
        return createSession({
          id: agentSessionId,
          settings: {
            model: "gpt-5.2",
            permissionModeId: "auto",
            planMode: false,
            reasoningEffort: "high"
          },
          runtimeContext: {
            configOptions: [
              {
                currentValue: "gpt-5.2",
                id: "model",
                options: [{ name: "GPT-5.2", value: "gpt-5.2" }]
              }
            ]
          }
        });
      }
    })
  });

  const state = await api.agentSessions.getState({
    agentSessionId: "persisted-session"
  });

  assert.deepEqual(state.settings, {
    model: "gpt-5.2",
    permissionModeId: "auto",
    planMode: false,
    reasoningEffort: "high"
  });
  assert.deepEqual(state.runtimeContext?.configOptions, [
    {
      currentValue: "gpt-5.2",
      id: "model",
      options: [{ name: "GPT-5.2", value: "gpt-5.2" }]
    }
  ]);
});

test("desktop agent host api resolves root cwd through tuttid workspace files", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(
        requestWorkspaceId: string,
        request: { agentSessionId: string }
      ) {
        calls.push({
          args: [requestWorkspaceId, request],
          method: "create"
        });
        return createSession({
          id: request.agentSessionId,
          status: "created"
        });
      },
      async listWorkspaceFileDirectory(requestWorkspaceId, request) {
        calls.push({
          args: [requestWorkspaceId, request],
          method: "listDirectory"
        });
        return {
          directoryPath: "/",
          entries: [],
          root: "/Users/example/project/tutti",
          workspaceId: requestWorkspaceId
        };
      }
    })
  });

  await api.agentSessions.activate({
    agentSessionId: "33333333-3333-4333-8333-333333333333",
    cwd: "/",
    initialContent: [{ type: "text", text: "Build" }],
    mode: "new",
    title: "Build"
  });

  assert.deepEqual(calls, [
    {
      args: [workspaceId, {}],
      method: "listDirectory"
    },
    {
      args: [
        workspaceId,
        {
          agentSessionId: "33333333-3333-4333-8333-333333333333",
          cwd: "/Users/example/project/tutti",
          initialContent: [{ type: "text", text: "Build" }],
          model: null,
          permissionModeId: null,
          planMode: null,
          provider: "codex",
          reasoningEffort: null,
          title: "Build",
          visible: true
        }
      ],
      method: "create"
    }
  ]);
});

test("desktop agent host api creates no-project session cwd under user Documents/tutti", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api = createAgentHostApi({
    hostFilesApi: createHostFilesApi({
      async createUserDocumentsProjectDirectory(input) {
        calls.push({
          args: [input],
          method: "createUserDocumentsProjectDirectory"
        });
        return { path: `/Users/local/Documents/tutti/${input.name}` };
      }
    }),
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(
        requestWorkspaceId: string,
        request: { agentSessionId: string; cwd?: string | null }
      ) {
        calls.push({
          args: [requestWorkspaceId, request],
          method: "create"
        });
        return createSession({
          cwd: request.cwd ?? "/",
          id: request.agentSessionId,
          status: "created"
        });
      }
    })
  });

  const result = await api.agentSessions.activate({
    agentSessionId: "44444444-4444-4444-8444-444444444444",
    cwd: "",
    initialContent: [{ type: "text", text: "Scratch" }],
    mode: "new",
    title: "Scratch"
  });

  assert.equal(
    result.session.cwd,
    "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444"
  );
  assert.equal(
    api.userProjects.isNoProjectPath({
      path: "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444"
    }),
    true
  );
  assert.equal(
    api.userProjects.isNoProjectPath({
      path: "/Users/local/Documents/tutti/Demo project"
    }),
    false
  );
  assert.equal(
    api.userProjects.isNoProjectPath({
      path: "/tmp/tutti/session-44444444-4444-4444-8444-444444444444"
    }),
    false
  );
  assert.deepEqual(calls, [
    {
      args: [
        {
          name: "session-44444444-4444-4444-8444-444444444444"
        }
      ],
      method: "createUserDocumentsProjectDirectory"
    },
    {
      args: [
        workspaceId,
        {
          agentSessionId: "44444444-4444-4444-8444-444444444444",
          cwd: "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444",
          initialContent: [{ type: "text", text: "Scratch" }],
          model: null,
          permissionModeId: null,
          planMode: null,
          provider: "codex",
          reasoningEffort: null,
          title: "Scratch",
          visible: true
        }
      ],
      method: "create"
    }
  ]);
});

test("desktop agent host api remembers the default project selection per workspace", async () => {
  const projectSelectionWorkspaceId = "workspace-project-selection";
  const firstApi = createAgentHostApi({
    workspaceId: projectSelectionWorkspaceId
  });

  assert.equal(await firstApi.userProjects.getDefaultSelection(), null);

  await firstApi.userProjects.rememberDefaultSelection({ path: null });
  assert.deepEqual(await firstApi.userProjects.getDefaultSelection(), {
    path: null
  });

  const secondApi = createAgentHostApi({
    workspaceId: projectSelectionWorkspaceId
  });
  assert.deepEqual(await secondApi.userProjects.getDefaultSelection(), {
    path: null
  });

  await secondApi.userProjects.use({ path: "/workspace/tutti" });
  assert.deepEqual(await firstApi.userProjects.getDefaultSelection(), {
    path: "/workspace/tutti"
  });
});

test("desktop agent host api delegates user project calls to the workspace user project service", async () => {
  const calls: Array<{ input?: unknown; method: string }> = [];
  const store = {
    error: null,
    initialized: true,
    isLoading: false,
    projects: [
      {
        createdAtUnixMs: 1,
        id: "project-listed",
        label: "Listed",
        lastUsedAtUnixMs: null,
        path: "/workspace/listed",
        updatedAtUnixMs: 1
      }
    ],
    revision: 1
  } as IWorkspaceUserProjectService["store"];
  const workspaceUserProjectService: IWorkspaceUserProjectService = {
    _serviceBrand: undefined,
    store,
    async checkProjectPath(path) {
      calls.push({ input: path, method: "checkProjectPath" });
      return {
        exists: true,
        isDirectory: true,
        path
      };
    },
    async createProject(name) {
      calls.push({ input: name, method: "createProject" });
      return {
        id: "project-created",
        label: name,
        lastUsedAtUnixMs: null,
        path: `/workspace/${name}`
      };
    },
    async ensureLoaded() {
      calls.push({ method: "ensureLoaded" });
    },
    async prepareSelection(input) {
      calls.push({ input, method: "prepareSelection" });
      return {
        isSelectedPathMissing: false,
        projects: store.projects,
        selection: { kind: "none" as const }
      };
    },
    async getDefaultSelection() {
      calls.push({ method: "getDefaultSelection" });
      return { path: "/workspace/listed" };
    },
    getRevision() {
      return store.revision;
    },
    getSnapshot() {
      return store;
    },
    isNoProjectPath(path) {
      calls.push({ input: path, method: "isNoProjectPath" });
      return path.includes("session-");
    },
    rememberNoProjectPath(path) {
      calls.push({ input: path, method: "rememberNoProjectPath" });
    },
    async refresh() {
      calls.push({ method: "refresh" });
    },
    async registerProjectPath(path) {
      calls.push({ input: path, method: "registerProjectPath" });
      return {
        id: "project-used",
        label: "Used",
        path
      };
    },
    async removeProjectPath(path) {
      calls.push({ input: path, method: "removeProjectPath" });
    },
    async rememberDefaultSelection(input) {
      calls.push({ input, method: "rememberDefaultSelection" });
    },
    async selectDirectory() {
      calls.push({ method: "selectDirectory" });
      return { path: "/workspace/listed" };
    },
    subscribe(listener) {
      calls.push({ input: listener, method: "subscribe" });
      return () => {
        calls.push({ method: "unsubscribe" });
      };
    }
  };
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        throw new Error("userProjects.list should use the service");
      },
      async useUserProject() {
        throw new Error("userProjects.use should use the service");
      }
    }),
    workspaceUserProjectService
  });

  const listResult = await api.userProjects.list();
  const created = await api.userProjects.create({ name: "created" });
  const used = await api.userProjects.use({ path: "/workspace/used" });
  const prepared = await api.userProjects.prepareSelection?.({
    projectLocked: true,
    selectedPath: "/workspace/listed"
  });
  await api.userProjects.remove?.({ path: "/workspace/listed" });
  const listener = () => {};
  const unsubscribe = api.userProjects.subscribe(listener);
  unsubscribe();

  assert.deepEqual(listResult, {
    projects: [
      {
        createdAtUnixMs: 1,
        id: "project-listed",
        label: "Listed",
        path: "/workspace/listed",
        updatedAtUnixMs: 1
      }
    ]
  });
  assert.equal("lastUsedAtUnixMs" in listResult.projects[0]!, false);
  assert.deepEqual(created, {
    id: "project-created",
    label: "created",
    path: "/workspace/created"
  });
  assert.equal("lastUsedAtUnixMs" in created, false);
  assert.deepEqual(used, {
    id: "project-used",
    label: "Used",
    path: "/workspace/used"
  });
  assert.deepEqual(prepared, {
    isSelectedPathMissing: false,
    projects: [
      {
        createdAtUnixMs: 1,
        id: "project-listed",
        label: "Listed",
        path: "/workspace/listed",
        updatedAtUnixMs: 1
      }
    ],
    selection: { kind: "none" }
  });
  assert.deepEqual(await api.userProjects.checkPath({ path: "/workspace" }), {
    exists: true,
    isDirectory: true,
    path: "/workspace"
  });
  assert.deepEqual(await api.userProjects.getDefaultSelection(), {
    path: "/workspace/listed"
  });
  await api.userProjects.rememberDefaultSelection({ path: null });
  assert.equal(
    api.userProjects.isNoProjectPath({ path: "/workspace/session-1" }),
    true
  );
  assert.deepEqual(calls, [
    { method: "ensureLoaded" },
    { input: "created", method: "createProject" },
    { input: "/workspace/used", method: "registerProjectPath" },
    {
      input: {
        projectLocked: true,
        selectedPath: "/workspace/listed"
      },
      method: "prepareSelection"
    },
    { input: "/workspace/listed", method: "removeProjectPath" },
    { input: listener, method: "subscribe" },
    { method: "unsubscribe" },
    { input: "/workspace", method: "checkProjectPath" },
    { method: "getDefaultSelection" },
    { input: { path: null }, method: "rememberDefaultSelection" },
    { input: "/workspace/session-1", method: "isNoProjectPath" }
  ]);
});

test("desktop agent host api reports failed activation from tuttid session", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, request) {
        return createSession({
          id: request.agentSessionId,
          lastError: `exec: "codex-acp": executable file not found in $PATH`,
          status: "failed"
        });
      }
    }),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    }
  });

  const result = await api.agentSessions.activate({
    agentSessionId: "44444444-4444-4444-8444-444444444444",
    cwd: "/workspace",
    mode: "new",
    title: "Smoke"
  });

  assert.equal(result.activation.status, "failed");
  assert.equal(result.session.status, "failed");
  assert.deepEqual(result.error, {
    code: "agent_session_start_failed",
    debugMessage: `exec: "codex-acp": executable file not found in $PATH`,
    message: `exec: "codex-acp": executable file not found in $PATH`
  });
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "error.agent_session_failed",
        params: {
          agent_session_id: "44444444-4444-4444-8444-444444444444",
          error_code: "agent_session_start_failed",
          is_retryable: false,
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent host api reconciles event hub dirty signals into full session events", async () => {
  type AgentActivityDirtySignalListener = (event: {
    payload: {
      agentSessionId: string;
      eventType: string;
      workspaceId: string;
    };
  }) => void;
  const eventHubListenerRef: {
    current: AgentActivityDirtySignalListener | null;
  } = { current: null };
  const subscribeToEventHub: TuttidEventStreamClient["subscribe"] = (
    topic,
    listener
  ) => {
    if (topic === "agent.activity.updated") {
      eventHubListenerRef.current =
        listener as AgentActivityDirtySignalListener;
    }
    return () => {};
  };
  const eventStreamClient: TuttidEventStreamClient = {
    async connect() {},
    dispose() {},
    async publishIntent() {},
    subscribe: subscribeToEventHub,
    subscribeConnectionState() {
      return () => {};
    }
  };
  const messageRequests: Array<number | undefined> = [];
  const tuttidClient = createTuttidClient({
    async getWorkspaceAgentSession(_workspaceId, agentSessionId) {
      return createSession({
        id: agentSessionId,
        status: "completed",
        title: "Answered"
      });
    },
    async listWorkspaceAgentSessionMessages(
      requestWorkspaceId,
      agentSessionId,
      request
    ) {
      assert.equal(requestWorkspaceId, workspaceId);
      assert.equal(agentSessionId, "agent-session-1");
      messageRequests.push(request?.afterVersion);
      assert.equal(request?.afterVersion, 0);
      const includeUser = messageRequests.length > 1;
      return {
        agentSessionId,
        hasMore: false,
        latestVersion: includeUser ? 3 : 2,
        messages: [
          ...(includeUser
            ? [
                {
                  agentSessionId,
                  id: 1,
                  kind: "text",
                  messageId: "message-1",
                  occurredAtUnixMs: 1717200001000,
                  payload: { text: "from user" },
                  role: "user",
                  status: "completed",
                  turnId: "turn-1",
                  version: 1
                }
              ]
            : []),
          {
            agentSessionId,
            id: 2,
            kind: "text",
            messageId: "message-2",
            occurredAtUnixMs: 1717200002000,
            payload: { text: "from reconcile" },
            role: "assistant",
            status: "completed",
            version: 2
          }
        ]
      };
    },
    async listWorkspaceAgentSessions() {
      return {
        sessions: [createSession({ id: "agent-session-1" })],
        workspaceId
      };
    }
  });
  const api = createAgentHostApi({
    tuttidClient,
    workspaceAgentActivityService: new WorkspaceAgentActivityService({
      eventStreamClient,
      tuttidClient,
      runtimeApi: createRuntimeApi()
    })
  });
  const receivedEvents: unknown[] = [];
  const unsubscribe = api.agentSessions.onEvent((event) =>
    receivedEvents.push(event)
  );

  await api.workspaceAgents.list();
  await waitFor(() => eventHubListenerRef.current !== null);
  const publishDirtySignal = eventHubListenerRef.current;
  if (!publishDirtySignal) {
    throw new Error("Event hub listener was not registered.");
  }
  publishDirtySignal({
    payload: {
      agentSessionId: "agent-session-1",
      eventType: "message_update",
      workspaceId
    }
  });
  await waitFor(() =>
    receivedEvents.some((event) => {
      const data = (event as { data?: { messageId?: string } }).data;
      return data?.messageId === "message-2";
    })
  );
  const messageEvent = receivedEvents.find((event) => {
    const data = (event as { data?: { messageId?: string } }).data;
    return data?.messageId === "message-2";
  }) as
    | {
        data: {
          messageId: string;
          payload?: Record<string, unknown>;
          seq?: number;
          workspaceId?: string;
        };
        eventType: string;
      }
    | undefined;
  assert.deepEqual(messageEvent, {
    data: {
      agentSessionId: "agent-session-1",
      completedAtUnixMs: undefined,
      kind: "text",
      messageId: "message-2",
      occurredAtUnixMs: 1717200002000,
      payload: { text: "from reconcile" },
      role: "assistant",
      seq: 2,
      startedAtUnixMs: undefined,
      status: "completed",
      turnId: undefined,
      workspaceId
    },
    eventType: "message_update"
  });
  publishDirtySignal({
    payload: {
      agentSessionId: "agent-session-1",
      eventType: "message_update",
      workspaceId
    }
  });
  await waitFor(() =>
    receivedEvents.some((event) => {
      const data = (event as { data?: { messageId?: string } }).data;
      return data?.messageId === "message-1";
    })
  );
  unsubscribe();
  assert.deepEqual(messageRequests, [0, 0]);
});

test("desktop agent host api batches inline streaming message updates", async () => {
  type AgentActivityDirtySignalListener = (event: {
    payload: {
      agentSessionId: string;
      data?: unknown;
      eventType: string;
      workspaceId: string;
    };
  }) => void;
  const eventHubListenerRef: {
    current: AgentActivityDirtySignalListener | null;
  } = { current: null };
  const eventStreamClient: TuttidEventStreamClient = {
    async connect() {},
    dispose() {},
    async publishIntent() {},
    subscribe(topic, listener) {
      if (topic === "agent.activity.updated") {
        eventHubListenerRef.current =
          listener as AgentActivityDirtySignalListener;
      }
      return () => {};
    },
    subscribeConnectionState() {
      return () => {};
    }
  };
  let messageRequestCount = 0;
  const tuttidClient = createTuttidClient({
    async listWorkspaceAgentSessionMessages(_workspaceId, agentSessionId) {
      messageRequestCount += 1;
      return {
        agentSessionId,
        hasMore: false,
        latestVersion: 0,
        messages: []
      };
    },
    async listWorkspaceAgentSessions() {
      return {
        sessions: [createSession({ id: "agent-session-1" })],
        workspaceId
      };
    }
  });
  const api = createAgentHostApi({
    tuttidClient,
    workspaceAgentActivityService: new WorkspaceAgentActivityService({
      eventStreamClient,
      tuttidClient,
      runtimeApi: createRuntimeApi()
    })
  });
  const receivedEvents: unknown[] = [];
  const unsubscribe = api.agentSessions.onEvent((event) =>
    receivedEvents.push(event)
  );

  await api.workspaceAgents.list();
  await waitFor(() => eventHubListenerRef.current !== null);
  const publishDirtySignal = eventHubListenerRef.current;
  if (!publishDirtySignal) {
    throw new Error("Event hub listener was not registered.");
  }
  publishDirtySignal({
    payload: {
      agentSessionId: "agent-session-1",
      data: {
        messages: [
          inlineActivityMessage({
            messageId: "message-1",
            text: "Hel",
            version: 1
          })
        ]
      },
      eventType: "message_update",
      workspaceId
    }
  });
  publishDirtySignal({
    payload: {
      agentSessionId: "agent-session-1",
      data: {
        messages: [
          inlineActivityMessage({
            messageId: "message-1",
            text: "Hello",
            version: 2
          })
        ]
      },
      eventType: "message_update",
      workspaceId
    }
  });

  assert.equal(receivedEvents.length, 0);
  await waitFor(() =>
    receivedEvents.some((event) => {
      const data = (event as { data?: { payload?: { text?: string } } }).data;
      return data?.payload?.text === "Hello";
    })
  );
  unsubscribe();

  const messageEvents = receivedEvents.filter(
    (event) => (event as { eventType?: string }).eventType === "message_update"
  );
  assert.equal(messageEvents.length, 1);
  assert.equal(
    (
      messageEvents[0] as {
        data?: { payload?: { text?: string }; seq?: number };
      }
    ).data?.payload?.text,
    "Hello"
  );
  assert.equal(
    (
      messageEvents[0] as {
        data?: { payload?: { text?: string }; seq?: number };
      }
    ).data?.seq,
    2
  );
  assert.equal(messageRequestCount, 0);
});

test("desktop agent host api preserves working state for user-only reconciled turns", async () => {
  type AgentActivityDirtySignalListener = (event: {
    payload: {
      agentSessionId: string;
      eventType: string;
      workspaceId: string;
    };
  }) => void;
  const eventHubListenerRef: {
    current: AgentActivityDirtySignalListener | null;
  } = { current: null };
  const eventStreamClient: TuttidEventStreamClient = {
    async connect() {},
    dispose() {},
    async publishIntent() {},
    subscribe(topic, listener) {
      if (topic === "agent.activity.updated") {
        eventHubListenerRef.current =
          listener as AgentActivityDirtySignalListener;
      }
      return () => {};
    },
    subscribeConnectionState() {
      return () => {};
    }
  };
  const tuttidClient = createTuttidClient({
    async getWorkspaceAgentSession(_workspaceId, agentSessionId) {
      return createSession({
        id: agentSessionId,
        status: "created",
        title: "Planning"
      });
    },
    async listWorkspaceAgentSessionMessages(
      _workspaceId,
      agentSessionId,
      request
    ) {
      assert.equal(request?.afterVersion, 0);
      return {
        agentSessionId,
        hasMore: false,
        latestVersion: 1,
        messages: [
          {
            agentSessionId,
            id: 1,
            kind: "text",
            messageId: "message-1",
            occurredAtUnixMs: 1717200001000,
            payload: { text: "plan this" },
            role: "user",
            status: "completed",
            turnId: "turn-1",
            version: 1
          }
        ]
      };
    },
    async listWorkspaceAgentSessions() {
      return {
        sessions: [createSession({ id: "agent-session-1" })],
        workspaceId
      };
    }
  });
  const api = createAgentHostApi({
    tuttidClient,
    workspaceAgentActivityService: new WorkspaceAgentActivityService({
      eventStreamClient,
      tuttidClient,
      runtimeApi: createRuntimeApi()
    })
  });
  const receivedEvents: unknown[] = [];
  const unsubscribe = api.agentSessions.onEvent((event) =>
    receivedEvents.push(event)
  );

  await api.workspaceAgents.list();
  await waitFor(() => eventHubListenerRef.current !== null);
  const publishDirtySignal = eventHubListenerRef.current;
  if (!publishDirtySignal) {
    throw new Error("Event hub listener was not registered.");
  }
  publishDirtySignal({
    payload: {
      agentSessionId: "agent-session-1",
      eventType: "message_update",
      workspaceId
    }
  });
  await waitFor(() =>
    receivedEvents.some((event) => {
      const data = (
        event as {
          data?: { agentSessionId?: string; currentPhase?: string };
          eventType?: string;
        }
      ).data;
      return (
        (event as { eventType?: string }).eventType === "state_patch" &&
        data?.agentSessionId === "agent-session-1" &&
        data.currentPhase === "working"
      );
    })
  );
  unsubscribe();

  const statePatch = receivedEvents.find((event) => {
    const data = (
      event as {
        data?: { agentSessionId?: string; currentPhase?: string };
        eventType?: string;
      }
    ).data;
    return (
      (event as { eventType?: string }).eventType === "state_patch" &&
      data?.agentSessionId === "agent-session-1"
    );
  }) as
    | {
        data: {
          currentPhase?: string;
          turn?: { phase?: string; turnId?: string };
        };
      }
    | undefined;
  assert.equal(statePatch?.data.currentPhase, "working");
  assert.deepEqual(statePatch?.data.turn, {
    phase: "working",
    turnId: "turn-1"
  });
});

test("desktop agent host api ignores stale reconcile after session deletion", async () => {
  type AgentActivityDirtySignalListener = (event: {
    payload: {
      agentSessionId: string;
      data?: unknown;
      eventType: string;
      workspaceId: string;
    };
  }) => void;
  const eventHubListenerRef: {
    current: AgentActivityDirtySignalListener | null;
  } = { current: null };
  const eventStreamClient: TuttidEventStreamClient = {
    async connect() {},
    dispose() {},
    async publishIntent() {},
    subscribe(topic, listener) {
      if (topic === "agent.activity.updated") {
        eventHubListenerRef.current =
          listener as AgentActivityDirtySignalListener;
      }
      return () => {};
    },
    subscribeConnectionState() {
      return () => {};
    }
  };
  const getSessionStarted = deferred<void>();
  const getSessionResponse = deferred<WorkspaceAgentSession>();
  let getSessionReturned = false;
  const tuttidClient = createTuttidClient({
    async getWorkspaceAgentSession(_workspaceId, agentSessionId) {
      getSessionStarted.resolve();
      const session = await getSessionResponse.promise;
      getSessionReturned = true;
      return createSession({
        ...session,
        id: agentSessionId,
        status: "running",
        updatedAt: "2026-05-31T00:00:02Z"
      });
    },
    async listWorkspaceAgentSessionMessages(_workspaceId, agentSessionId) {
      return {
        agentSessionId,
        hasMore: false,
        latestVersion: 0,
        messages: []
      };
    },
    async listWorkspaceAgentSessions() {
      return {
        sessions: [createSession({ id: "agent-session-1" })],
        workspaceId
      };
    }
  });
  const workspaceAgentActivityService = new WorkspaceAgentActivityService({
    eventStreamClient,
    tuttidClient,
    runtimeApi: createRuntimeApi()
  });
  const api = createAgentHostApi({
    tuttidClient,
    workspaceAgentActivityService
  });

  await api.workspaceAgents.list();
  await waitFor(() => eventHubListenerRef.current !== null);
  const publishDirtySignal = eventHubListenerRef.current;
  if (!publishDirtySignal) {
    throw new Error("Event hub listener was not registered.");
  }
  publishDirtySignal({
    payload: {
      agentSessionId: "agent-session-1",
      eventType: "message_update",
      workspaceId
    }
  });
  await getSessionStarted.promise;
  publishDirtySignal({
    payload: {
      agentSessionId: "agent-session-1",
      data: {
        workspaceId,
        agentSessionId: "agent-session-1",
        eventType: "session_deleted",
        deletedAtUnixMs: 1717200003000
      },
      eventType: "session_deleted",
      workspaceId
    }
  });
  assert.equal(
    workspaceAgentActivityService.getSnapshot(workspaceId).sessions.length,
    0
  );

  getSessionResponse.resolve(createSession({ id: "agent-session-1" }));
  await waitFor(() => getSessionReturned);
  await Promise.resolve();

  assert.equal(
    workspaceAgentActivityService.getSnapshot(workspaceId).sessions.length,
    0
  );
});

test("desktop agent host api propagates tuttid session message errors", async () => {
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async listWorkspaceAgentSessionMessages() {
        throw new Error("tuttid unavailable");
      }
    })
  });

  await assert.rejects(
    () =>
      api.workspaceAgents.listSessionMessages({
        agentSessionId: "agent-session-1"
      }),
    /tuttid unavailable/
  );
});

test("desktop agent host api prefers persisted tuttid session messages when available", async () => {
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async listWorkspaceAgentSessionMessages(
        requestWorkspaceId: string,
        agentSessionId: string,
        request?: { afterVersion?: number; limit?: number }
      ) {
        assert.equal(requestWorkspaceId, workspaceId);
        assert.equal(agentSessionId, "agent-session-1");
        assert.equal(request?.afterVersion, 3);
        assert.equal(request?.limit, 10);
        return {
          agentSessionId,
          hasMore: false,
          latestVersion: 8,
          messages: [
            {
              agentSessionId,
              id: 8,
              kind: "text",
              messageId: "message-8",
              occurredAtUnixMs: 1717200001000,
              payload: { text: "from tuttid" },
              role: "assistant",
              version: 8
            }
          ]
        };
      }
    })
  });

  const page = await api.workspaceAgents.listSessionMessages({
    afterVersion: 3,
    agentSessionId: "agent-session-1",
    limit: 10
  });

  assert.deepEqual(page, {
    hasMore: false,
    latestVersion: 8,
    messages: [
      {
        agentSessionId: "agent-session-1",
        completedAtUnixMs: undefined,
        id: 8,
        kind: "text",
        messageId: "message-8",
        occurredAtUnixMs: 1717200001000,
        payload: { text: "from tuttid" },
        role: "assistant",
        startedAtUnixMs: undefined,
        status: undefined,
        turnId: undefined,
        version: 8,
        workspaceId: "workspace-1"
      }
    ]
  });

  const snapshot = await api.workspaceAgents.list();
  assert.equal(
    snapshot.sessionMessagesById["agent-session-1"]?.some(
      (message) => message.messageId === "message-8"
    ),
    true
  );
});

test("desktop agent host api preserves frontend session UUIDs as canonical ids", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const receivedEvents: unknown[] = [];
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(requestWorkspaceId, request) {
        calls.push({ args: [requestWorkspaceId, request], method: "create" });
        return createSession({
          id: request.agentSessionId,
          resumable: true,
          status: "created"
        });
      },
      async listWorkspaceAgentSessions() {
        return {
          sessions: [
            createSession({
              id: "55555555-5555-4555-8555-555555555555",
              resumable: true,
              status: "running"
            })
          ],
          workspaceId
        };
      },
      async listWorkspaceAgentSessionMessages(
        _workspaceId: string,
        agentSessionId: string
      ) {
        return {
          agentSessionId,
          hasMore: false,
          latestVersion: 3,
          messages: [
            {
              agentSessionId,
              id: 3,
              kind: "text",
              messageId: "message-1",
              payload: { text: "ok" },
              role: "assistant",
              status: "completed",
              version: 3
            }
          ]
        };
      },
      async getWorkspaceAgentSession(
        _workspaceId: string,
        agentSessionId: string
      ) {
        return createSession({ id: agentSessionId, resumable: true });
      },
      async sendWorkspaceAgentSessionInput(
        requestWorkspaceId: string,
        agentSessionId: string,
        request: unknown
      ) {
        calls.push({
          args: [requestWorkspaceId, agentSessionId, request],
          method: "input"
        });
        return createSession({
          id: agentSessionId,
          resumable: true,
          status: "running"
        });
      }
    })
  });

  const activated = await api.agentSessions.activate({
    agentSessionId: "55555555-5555-4555-8555-555555555555",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "Smoke" }],
    mode: "new",
    settings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "high"
    },
    title: "Smoke"
  });
  const canonicalAgentSessionId = activated.session.agentSessionId;
  const input = await api.agentSessions.exec({
    agentSessionId: canonicalAgentSessionId,
    content: [{ type: "text", text: "continue" }]
  });
  const state = await api.agentSessions.getState({
    agentSessionId: canonicalAgentSessionId
  });
  const unsubscribe = api.agentSessions.subscribeEvents(
    { agentSessionId: canonicalAgentSessionId },
    (event) => receivedEvents.push(event)
  );
  const page = await api.workspaceAgents.listSessionMessages({
    agentSessionId: canonicalAgentSessionId
  });
  const snapshot = await api.workspaceAgents.list();
  unsubscribe();

  assert.equal(
    activated.session.agentSessionId,
    "55555555-5555-4555-8555-555555555555"
  );
  assert.equal(
    activated.session.providerSessionId,
    "55555555-5555-4555-8555-555555555555"
  );
  assert.equal(activated.session.resumable, true);
  assert.equal(input.status, "started");
  assert.deepEqual(state.settings, {
    model: "gpt-5",
    permissionModeId: "auto",
    planMode: false,
    reasoningEffort: "high"
  });
  assert.deepEqual(state.runtimeContext?.configOptions, [
    {
      currentValue: "gpt-5",
      id: "model",
      options: [{ name: "gpt-5", value: "gpt-5" }]
    },
    {
      currentValue: "high",
      id: "reasoning_effort",
      options: [
        { name: "Minimal", value: "minimal" },
        { name: "Low", value: "low" },
        { name: "Medium", value: "medium" },
        { name: "High", value: "high" },
        { name: "X-High", value: "xhigh" }
      ]
    }
  ]);
  assert.equal(state.resumable, true);
  assert.equal(
    (receivedEvents[0] as { data?: { agentSessionId?: string } })?.data
      ?.agentSessionId,
    "55555555-5555-4555-8555-555555555555"
  );
  assert.equal(
    page.messages[0]?.agentSessionId,
    "55555555-5555-4555-8555-555555555555"
  );
  assert.equal(
    snapshot.sessions[0]?.agentSessionId,
    "55555555-5555-4555-8555-555555555555"
  );
  assert.equal(
    snapshot.sessions[0]?.providerSessionId,
    "55555555-5555-4555-8555-555555555555"
  );
  assert.equal(snapshot.sessions[0]?.resumable, true);
  assert.equal(snapshot.sessions[0]?.turnPhase, "working");
  assert.deepEqual(calls, [
    {
      args: [
        workspaceId,
        {
          agentSessionId: "55555555-5555-4555-8555-555555555555",
          cwd: "/workspace",
          initialContent: [{ type: "text", text: "Smoke" }],
          model: "gpt-5",
          permissionModeId: "auto",
          planMode: false,
          provider: "codex",
          reasoningEffort: "high",
          title: "Smoke",
          visible: true
        }
      ],
      method: "create"
    },
    {
      args: [
        workspaceId,
        "55555555-5555-4555-8555-555555555555",
        { content: [{ type: "text", text: "continue" }] }
      ],
      method: "input"
    }
  ]);
});

test("desktop agent host api keeps canonical sessions across adapter recreation", async () => {
  const remountWorkspaceId = "workspace-remount";
  const getCalls: Array<{ workspaceId: string; agentSessionId: string }> = [];
  const firstApi = createAgentHostApi({
    workspaceId: remountWorkspaceId,
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, request) {
        return createSession({ id: request.agentSessionId });
      }
    })
  });

  const activated = await firstApi.agentSessions.activate({
    agentSessionId: "66666666-6666-4666-8666-666666666666",
    cwd: "/workspace",
    mode: "new",
    settings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "medium"
    },
    visible: false
  });
  const canonicalAgentSessionId = activated.session.agentSessionId;

  const recreatedApi = createAgentHostApi({
    workspaceId: remountWorkspaceId,
    tuttidClient: createTuttidClient({
      async getWorkspaceAgentSession(workspaceId, agentSessionId) {
        getCalls.push({ workspaceId, agentSessionId });
        return createSession({ id: agentSessionId });
      },
      async listWorkspaceAgentSessions() {
        return {
          sessions: [
            createSession({ id: "66666666-6666-4666-8666-666666666666" })
          ],
          workspaceId: remountWorkspaceId
        };
      }
    })
  });

  const state = await recreatedApi.agentSessions.getState({
    agentSessionId: canonicalAgentSessionId
  });
  const hiddenSnapshot = await recreatedApi.workspaceAgents.list();
  await recreatedApi.agentSessions.activate({
    agentSessionId: canonicalAgentSessionId,
    mode: "existing",
    visible: true
  });
  const visibleSnapshot = await recreatedApi.workspaceAgents.list();

  assert.deepEqual(getCalls, [
    {
      agentSessionId: "66666666-6666-4666-8666-666666666666",
      workspaceId: remountWorkspaceId
    },
    {
      agentSessionId: "66666666-6666-4666-8666-666666666666",
      workspaceId: remountWorkspaceId
    }
  ]);
  assert.equal(state.agentSessionId, "66666666-6666-4666-8666-666666666666");
  assert.deepEqual(state.settings, {
    model: "gpt-5",
    permissionModeId: "auto",
    planMode: false,
    reasoningEffort: "medium"
  });
  assert.deepEqual(hiddenSnapshot.sessions, []);
  assert.equal(
    visibleSnapshot.sessions[0]?.agentSessionId,
    "66666666-6666-4666-8666-666666666666"
  );
  assert.equal(
    visibleSnapshot.sessions[0]?.providerSessionId,
    "66666666-6666-4666-8666-666666666666"
  );
  assert.equal(
    visibleSnapshot.sessions[0]?.sessionOrigin,
    "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
  );
});

test("desktop agent host api reuses desktop host file operations", async () => {
  const usedProjectPaths: string[] = [];
  const writtenFiles: Array<{
    content: string;
    path: string;
    workspaceId: string;
  }> = [];
  const api = createAgentHostApi({
    hostFilesApi: createHostFilesApi({
      async createUserDocumentsProjectDirectory(input) {
        assert.deepEqual(input, { name: "Demo project" });
        return { path: "/Users/local/Documents/tutti/Demo project" };
      },
      async readPreviewFile(requestWorkspaceId, path) {
        assert.equal(requestWorkspaceId, workspaceId);
        assert.equal(path, "/workspace/file.txt");
        return new TextEncoder().encode("hello");
      },
      async readLocalFileText(path) {
        assert.equal(path, "/tmp/prompt.md");
        return {
          content: "prompt",
          name: "prompt.md",
          path
        };
      },
      async selectDirectory() {
        return "/workspace";
      },
      async selectUploadFiles() {
        return ["/tmp/a.txt", "/tmp/b.txt"];
      }
    }),
    tuttidClient: createTuttidClient({
      async checkUserProjectPath(payload) {
        return {
          exists: true,
          isDirectory: true,
          path: payload.path
        };
      },
      async useUserProject(payload) {
        usedProjectPaths.push(payload.path);
        return {
          createdAtUnixMs: 1,
          id: "project-1",
          label: "Demo project",
          path: payload.path,
          updatedAtUnixMs: 1
        };
      },
      async writeWorkspaceFileText(requestWorkspaceId, request) {
        writtenFiles.push({
          content: request.content,
          path: request.path,
          workspaceId: requestWorkspaceId
        });
        return {
          entry: {
            createdTimeMs: null,
            hasChildren: false,
            kind: "file",
            lastOpenedMs: null,
            mtimeMs: null,
            name: request.path.split("/").filter(Boolean).at(-1) ?? "",
            path: request.path,
            sizeBytes: request.content.length
          },
          root: "/workspace",
          workspaceId: requestWorkspaceId
        };
      }
    }),
    platformApi: {
      homeDirectory: "/Users/local",
      os: "darwin",
      resolveDroppedPaths(files) {
        return files.map((file) => `/resolved/${file.name}`);
      }
    }
  });

  assert.deepEqual(await api.workspace.selectDirectory(), {
    path: "/workspace"
  });
  assert.deepEqual(await api.userProjects.create?.({ name: "Demo project" }), {
    createdAtUnixMs: 1,
    id: "project-1",
    label: "Demo project",
    path: "/Users/local/Documents/tutti/Demo project",
    updatedAtUnixMs: 1
  });
  assert.deepEqual(await api.userProjects.checkPath?.({ path: "/workspace" }), {
    exists: true,
    isDirectory: true,
    path: "/workspace"
  });
  assert.deepEqual(usedProjectPaths, [
    "/Users/local/Documents/tutti/Demo project"
  ]);
  assert.deepEqual(await api.workspace.selectFiles(), [
    { path: "/tmp/a.txt" },
    { path: "/tmp/b.txt" }
  ]);
  const readFileResult = await api.workspace.readFile({
    path: "/workspace/file.txt"
  });
  assert.deepEqual(readFileResult, {
    bytes: new TextEncoder().encode("hello"),
    content: "hello",
    path: "/workspace/file.txt"
  });
  assert.equal(
    api.workspace.getPathForFile(new File([], "drop.txt")),
    "/resolved/drop.txt"
  );
  assert.deepEqual(
    await api.filesystem.readFileText({ uri: "file:///tmp/prompt.md" }),
    {
      content: "prompt",
      name: "prompt.md",
      path: "/tmp/prompt.md"
    }
  );
  await api.workspace.writeFileText({
    content: "updated",
    path: "/workspace/file.txt"
  });
  assert.deepEqual(writtenFiles, [
    {
      content: "updated",
      path: "/workspace/file.txt",
      workspaceId
    }
  ]);
});

type CreateAgentHostApiTestOverrides = Partial<
  Parameters<typeof createDesktopAgentHostApi>[0]
>;

function createAgentHostApi(
  overrides: CreateAgentHostApiTestOverrides = {}
): DesktopAgentHostApiUnderTest {
  const {
    hostFilesApi: overriddenHostFilesApi,
    tuttidClient: overriddenTuttidClient,
    runtimeApi: overriddenRuntimeApi,
    workspaceAgentActivityService,
    ...apiOverrides
  } = overrides;
  const hostFilesApi = overriddenHostFilesApi ?? createHostFilesApi();
  const tuttidClient = overriddenTuttidClient ?? createTuttidClient();
  const runtimeApi = overriddenRuntimeApi ?? createRuntimeApi();
  return createDesktopAgentHostApi({
    hostFilesApi,
    tuttidClient,
    platformApi: createPlatformApi(),
    runtimeApi,
    workspaceAgentActivityService:
      workspaceAgentActivityService ??
      new WorkspaceAgentActivityService({
        hostFilesApi,
        tuttidClient,
        runtimeApi
      }),
    workspaceId,
    ...apiOverrides
  }) as unknown as DesktopAgentHostApiUnderTest;
}

function createSession(
  overrides: Partial<WorkspaceAgentSession> = {}
): WorkspaceAgentSession {
  return {
    createdAt: "2026-05-31T00:00:00Z",
    cwd: "/workspace",
    id: "agent-session-1",
    provider: "codex",
    resumable: false,
    status: "created",
    title: "Agent",
    updatedAt: "2026-05-31T00:00:01Z",
    visible: true,
    ...overrides
  };
}

function requestPermissionModeValue(
  input:
    | {
        permissionModeId?: string | null;
      }
    | null
    | undefined
): string | null {
  const value = input?.permissionModeId;
  return typeof value === "string" && value.trim() ? value : null;
}

function createHostFilesApi(
  overrides: Partial<DesktopHostFilesApi> = {}
): DesktopHostFilesApi {
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
    },
    ...overrides
  };
}

function createPlatformApi(
  overrides: Partial<
    Pick<DesktopPlatformApi, "homeDirectory" | "os" | "resolveDroppedPaths">
  > = {}
): Pick<DesktopPlatformApi, "homeDirectory" | "os" | "resolveDroppedPaths"> {
  return {
    homeDirectory: "/Users/local",
    os: "darwin",
    resolveDroppedPaths() {
      return [];
    },
    ...overrides
  };
}

function createRuntimeApi(): DesktopRuntimeApi {
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
    async listWorkspaceAgentProbes(input) {
      return {
        capturedAtUnixMs: 1,
        providers: [],
        workspaceId: input.workspaceId
      };
    },
    async getTerminalStreamUrl(input: DesktopTerminalStreamUrlRequest) {
      return `ws://127.0.0.1:4000/${input.workspaceId}/${input.sessionId}`;
    },
    async logTerminalDiagnostic(_payload: DesktopTerminalDiagnosticPayload) {},
    async logRendererDiagnostic() {}
  };
}

function createTuttidClient(
  overrides: Partial<TuttidClient> = {}
): TuttidClient {
  return {
    async cancelWorkspaceAgentSession() {
      return createSession({ status: "canceled" });
    },
    async cancelWorkspaceAgentSessionWithResult() {
      return {
        cancel: {
          canceled: true,
          reason: "active_turn_canceled"
        },
        session: createSession({ status: "canceled" })
      };
    },
    async createWorkspaceAgentSession() {
      return createSession();
    },
    async deleteWorkspaceAgentSession() {
      return { removed: true };
    },
    async getWorkspaceAgentSession(
      _workspaceId: string,
      agentSessionId: string
    ) {
      return createSession({ id: agentSessionId });
    },
    async getAgentProviderComposerOptions(
      provider: Parameters<TuttidClient["getAgentProviderComposerOptions"]>[0],
      request: Parameters<TuttidClient["getAgentProviderComposerOptions"]>[1]
    ) {
      const settings = request?.settings ?? {};
      return {
        provider,
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
        runtimeContext: {
          configOptions: [
            {
              currentValue: settings.model ?? null,
              id: "model",
              options: settings.model
                ? [{ name: settings.model, value: settings.model }]
                : []
            },
            {
              currentValue: settings.reasoningEffort ?? null,
              id: "reasoning_effort",
              options: [
                { name: "Minimal", value: "minimal" },
                { name: "Low", value: "low" },
                { name: "Medium", value: "medium" },
                { name: "High", value: "high" },
                { name: "X-High", value: "xhigh" }
              ]
            }
          ],
          model: settings.model ?? null,
          permissionModeId: settings.permissionModeId ?? null,
          reasoningEffort: settings.reasoningEffort ?? null
        },
        skills: []
      };
    },
    async listWorkspaceAgentSessions() {
      return { sessions: [createSession()] };
    },
    async listWorkspaceAgentSessionMessages() {
      throw new Error("listWorkspaceAgentSessionMessages not mocked");
    },
    async listUserProjects() {
      return { projects: [] };
    },
    async checkUserProjectPath(
      request: Parameters<TuttidClient["checkUserProjectPath"]>[0]
    ) {
      return {
        exists: true,
        isDirectory: true,
        path: request.path
      };
    },
    async listWorkspaceFileDirectory() {
      return {
        directoryPath: "/",
        entries: [],
        root: "/"
      };
    },
    async submitWorkspaceAgentInteractive(
      _workspaceId: string,
      agentSessionId: string
    ) {
      return createSession({ id: agentSessionId });
    },
    async sendWorkspaceAgentSessionInput(
      _workspaceId: string,
      agentSessionId: string
    ) {
      return createSession({ id: agentSessionId, status: "running" });
    },
    async updateWorkspaceAgentSessionSettings(
      _workspaceId: string,
      agentSessionId: string,
      settings: Parameters<
        TuttidClient["updateWorkspaceAgentSessionSettings"]
      >[2]
    ) {
      return createSession({ id: agentSessionId, settings });
    },
    async updateWorkspaceAgentSessionPin(
      _workspaceId: string,
      agentSessionId: string,
      request: Parameters<TuttidClient["updateWorkspaceAgentSessionPin"]>[2]
    ) {
      return createSession({
        id: agentSessionId,
        pinnedAtUnixMs: request.pinned ? 1700000000000 : null
      });
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
    },
    ...overrides
  } as unknown as TuttidClient;
}

function inlineActivityMessage(input: {
  messageId: string;
  text: string;
  version: number;
}): Record<string, unknown> {
  return {
    agentSessionId: "agent-session-1",
    kind: "text",
    messageId: input.messageId,
    occurredAtUnixMs: 1717200000000 + input.version,
    payload: {
      text: input.text
    },
    role: "assistant",
    status: "streaming",
    version: input.version,
    workspaceId
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
