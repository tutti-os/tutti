import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttidClient,
  PermissionModeSemantic,
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage
} from "@tutti-os/client-tuttid-ts";
import { TuttidProtocolError } from "@tutti-os/client-tuttid-ts";
import { createDesktopAgentActivityAdapter } from "./desktopAgentActivityAdapter.ts";

const workspaceId = "workspace-1";

test("desktop agent activity adapter maps tuttid sessions and messages", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const diagnostics: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async listWorkspaceAgentSessions(
        requestWorkspaceId: string,
        request?: { limit?: number }
      ) {
        calls.push({
          args: [requestWorkspaceId, request],
          method: "listSessions"
        });
        return {
          sessions: [
            createSession({
              cwd: "/repo",
              endedAt: "2026-01-01T00:02:00.000Z",
              id: "agent-session-1",
              lastError: "needs input",
              status: "waiting",
              title: "Review"
            })
          ],
          workspaceId: requestWorkspaceId
        };
      },
      async listWorkspaceAgentSessionMessages(
        requestWorkspaceId: string,
        agentSessionId: string,
        request?: { afterVersion?: number; limit?: number }
      ) {
        calls.push({
          args: [requestWorkspaceId, agentSessionId, request],
          method: "listMessages"
        });
        return {
          agentSessionId,
          hasMore: false,
          latestVersion: 5,
          messages: [
            createMessage({
              agentSessionId,
              completedAtUnixMs: 1717200003000,
              id: 5,
              kind: "text",
              messageId: "message-5",
              occurredAtUnixMs: 1717200001000,
              payload: { text: "hello" },
              role: "assistant",
              startedAtUnixMs: 1717200002000,
              status: "completed",
              turnId: "turn-1",
              version: 5
            })
          ]
        };
      }
    }),
    runtimeApi: createRuntimeApi(diagnostics)
  });

  const sessions = await adapter.listSessions({ workspaceId });
  const messages = await adapter.listSessionMessages({
    afterVersion: 3,
    agentSessionId: "agent-session-1",
    limit: 10,
    workspaceId
  });

  assert.deepEqual(calls, [
    {
      args: [workspaceId, { limit: 100 }],
      method: "listSessions"
    },
    {
      args: [
        workspaceId,
        "agent-session-1",
        {
          afterVersion: 3,
          beforeVersion: undefined,
          limit: 10,
          order: undefined
        }
      ],
      method: "listMessages"
    }
  ]);
  assert.deepEqual(sessions.sessions, [
    {
      agentSessionId: "agent-session-1",
      createdAtUnixMs: Date.parse("2026-01-01T00:00:00.000Z"),
      cwd: "/repo",
      endedAtUnixMs: Date.parse("2026-01-01T00:02:00.000Z"),
      lastError: "needs input",
      lastEventUnixMs: Date.parse("2026-01-01T00:01:00.000Z"),
      pinnedAtUnixMs: null,
      provider: "codex",
      providerSessionId: "agent-session-1",
      resumable: false,
      startedAtUnixMs: Date.parse("2026-01-01T00:00:00.000Z"),
      status: "waiting",
      title: "Review",
      updatedAtUnixMs: Date.parse("2026-01-01T00:01:00.000Z"),
      visible: true,
      workspaceId
    }
  ]);
  assert.deepEqual(messages, {
    hasMore: false,
    latestVersion: 5,
    messages: [
      {
        agentSessionId: "agent-session-1",
        completedAtUnixMs: 1717200003000,
        id: 5,
        kind: "text",
        messageId: "message-5",
        occurredAtUnixMs: 1717200001000,
        payload: { text: "hello" },
        role: "assistant",
        startedAtUnixMs: 1717200002000,
        status: "completed",
        turnId: "turn-1",
        version: 5,
        workspaceId
      }
    ]
  });
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(diagnostics[0], {
    details: {
      afterVersion: 3,
      agentSessionId: "agent-session-1",
      beforeVersion: null,
      event: "requested",
      limit: 10,
      order: null
    },
    event: "agent.activity.messages.list",
    level: "info",
    workspaceId
  });
  const resolvedDiagnostic = diagnostics[1] as {
    details?: Record<string, unknown>;
    event?: string;
    level?: string;
    workspaceId?: string;
  };
  assert.equal(resolvedDiagnostic.event, "agent.activity.messages.list");
  assert.equal(resolvedDiagnostic.level, "info");
  assert.equal(resolvedDiagnostic.workspaceId, workspaceId);
  assert.equal(resolvedDiagnostic.details?.agentSessionId, "agent-session-1");
  assert.equal(resolvedDiagnostic.details?.event, "resolved");
  assert.equal(resolvedDiagnostic.details?.firstVersion, 5);
  assert.equal(resolvedDiagnostic.details?.lastVersion, 5);
  assert.equal(resolvedDiagnostic.details?.latestVersion, 5);
  assert.equal(resolvedDiagnostic.details?.messageCount, 1);
  assert.equal(typeof resolvedDiagnostic.details?.durationMs, "number");
});

test("desktop agent activity adapter returns cancel result metadata", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async cancelWorkspaceAgentSessionWithResult(
        requestWorkspaceId: string,
        agentSessionId: string
      ) {
        calls.push({
          args: [requestWorkspaceId, agentSessionId],
          method: "cancelWithResult"
        });
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
    runtimeApi: createRuntimeApi()
  });

  const result = await adapter.cancelSession({
    workspaceId,
    agentSessionId: "agent-session-1"
  });

  assert.deepEqual(calls, [
    {
      args: [workspaceId, "agent-session-1"],
      method: "cancelWithResult"
    }
  ]);
  assert.equal(result.canceled, false);
  assert.equal(result.reason, "no_active_turn");
  assert.equal(result.session.agentSessionId, "agent-session-1");
  assert.equal(result.session.status, "created");
});

test("desktop agent activity adapter rejects turnless message pages before core", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async listWorkspaceAgentSessionMessages(_workspaceId, agentSessionId) {
        const legacyMessage = createMessage({
          agentSessionId,
          createdAtUnixMs: 1717200001000,
          messageId: "message-without-turn",
          version: 5
        });
        delete (legacyMessage as { occurredAtUnixMs?: unknown })
          .occurredAtUnixMs;
        delete (legacyMessage as { turnId?: unknown }).turnId;
        return {
          agentSessionId,
          hasMore: false,
          latestVersion: 5,
          messages: [legacyMessage]
        };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await assert.rejects(
    () =>
      adapter.listSessionMessages({
        agentSessionId: "agent-session-1",
        workspaceId
      }),
    /message-without-turn.*missing turnId/
  );
});

test("desktop agent activity adapter forwards submit diagnostic metadata", async () => {
  const calls: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async sendWorkspaceAgentSessionInput(
        requestWorkspaceId,
        agentSessionId,
        request
      ) {
        calls.push({
          agentSessionId,
          request,
          workspaceId: requestWorkspaceId
        });
        return createSendInputResponse(
          createSession({ id: agentSessionId, status: "running" })
        );
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await adapter.sendInput({
    workspaceId,
    agentSessionId: "agent-session-1",
    content: [{ type: "text", text: "hello" }],
    metadata: {
      clientSubmitId: "submit-1",
      clientSubmittedAtUnixMs: 1234
    }
  });

  assert.deepEqual(calls, [
    {
      agentSessionId: "agent-session-1",
      request: {
        content: [{ type: "text", text: "hello" }],
        displayPrompt: null,
        metadata: {
          clientSubmitId: "submit-1",
          clientSubmittedAtUnixMs: 1234
        }
      },
      workspaceId
    }
  ]);
});

test("desktop agent activity adapter refreshes provider status and localizes adapter mismatch create failures", async () => {
  const refreshCalls: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    agentProviderStatusService: {
      async refresh(providers) {
        refreshCalls.push(providers);
      }
    },
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession() {
        throw new TuttidProtocolError({
          code: "workspace_operation_failed",
          developerMessage: "claude-code: ACP adapter not found",
          reason: "acp_adapter_version_mismatch",
          statusCode: 502
        });
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await assert.rejects(
    adapter.createSession({
      agentSessionId: "agent-session-1",
      agentTargetId: "local:claude-code",
      provider: "claude-code",
      workspaceId
    }),
    /Claude Code's local adapter is unavailable or version-mismatched/
  );

  assert.deepEqual(refreshCalls, [["claude-code"]]);
});

test("desktop agent activity adapter does not refresh provider status for unrelated create failures", async () => {
  const refreshCalls: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    agentProviderStatusService: {
      async refresh(providers) {
        refreshCalls.push(providers);
      }
    },
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession() {
        throw new TuttidProtocolError({
          code: "service_unavailable",
          developerMessage: "tuttid unavailable",
          reason: "service_unavailable",
          statusCode: 503
        });
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await assert.rejects(
    adapter.createSession({
      agentSessionId: "agent-session-1",
      agentTargetId: "local:claude-code",
      provider: "claude-code",
      workspaceId
    }),
    /service_unavailable|TuttidProtocolError|tuttid unavailable/
  );

  assert.deepEqual(refreshCalls, []);
});

test("desktop agent activity adapter requires an injected session event subscription", async () => {
  const diagnostics: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient(),
    runtimeApi: createRuntimeApi(diagnostics)
  });

  await assert.rejects(
    adapter.subscribeSessionEvents({
      agentSessionId: "agent-session-1",
      onEvent: () => {},
      signal: new AbortController().signal,
      workspaceId
    }),
    /subscription is unavailable/
  );

  assert.deepEqual(diagnostics, [
    {
      details: {
        error: "workspace agent session event subscription is unavailable"
      },
      event: "agent.gui.session_event.subscribe.unavailable",
      level: "warn",
      workspaceId
    }
  ]);
});

test("desktop agent activity adapter submits interactive responses through tuttid", async () => {
  const calls: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async submitWorkspaceAgentInteractive(
        requestWorkspaceId,
        agentSessionId,
        requestId,
        request
      ) {
        calls.push([requestWorkspaceId, agentSessionId, requestId, request]);
        return createSession({ id: agentSessionId, status: "waiting" });
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await adapter.submitInteractive({
    agentSessionId: "agent-session-1",
    optionId: "acceptEdits",
    payload: { path: "/Users/example/demo/src/styles.css" },
    requestId: "interactive-1",
    workspaceId
  });

  assert.deepEqual(calls, [
    [
      workspaceId,
      "agent-session-1",
      "interactive-1",
      {
        action: null,
        optionId: "acceptEdits",
        payload: { path: "/Users/example/demo/src/styles.css" }
      }
    ]
  ]);
});

test("desktop agent activity adapter normalizes provider composer options", async () => {
  const calls: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider, request) {
        calls.push([provider, request]);
        return {
          provider,
          effectiveSettings: {},
          modelConfig: {
            configurable: true,
            currentValue: "gpt-5.4",
            options: [
              { id: "gpt-5.5", value: "gpt-5.5", label: "GPT-5.5" },
              { id: "gpt-5.4", value: "gpt-5.4", label: "GPT-5.4" }
            ]
          },
          reasoningConfig: {
            configurable: true,
            currentValue: "high",
            options: [
              { id: "medium", value: "medium", label: "中" },
              { id: "high", value: "high", label: "高" }
            ]
          },
          permissionConfig: {
            configurable: true,
            defaultValue: "auto",
            modes: [
              {
                id: "custom-safe",
                label: "Custom safe",
                semantic: unknownPermissionModeSemantic("custom")
              },
              {
                id: "full-access",
                label: "完全访问",
                semantic: "full-access"
              }
            ]
          },
          runtimeContext: {
            configOptions: [],
            promptCapabilities: { image: true },
            skills: [
              {
                name: "Create App",
                trigger: "create-app",
                sourceKind: "bundled"
              }
            ]
          },
          skills: [],
          capabilityCatalog: []
        };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const options = await adapter.loadComposerOptions({
    workspaceId,
    provider: "codex",
    cwd: "/repo",
    settings: { model: "gpt-5.4" }
  });

  assert.deepEqual(calls, [
    [
      "codex",
      {
        cwd: "/repo",
        workspaceId,
        settings: { model: "gpt-5.4" }
      }
    ]
  ]);
  assert.equal(options.provider, "codex");
  assert.deepEqual(options.models, [
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.4", label: "GPT-5.4" }
  ]);
  assert.deepEqual(options.reasoningEfforts, [
    { value: "medium", label: "中" },
    { value: "high", label: "高" }
  ]);
  assert.deepEqual(options.permissionConfig, {
    configurable: true,
    defaultValue: "auto",
    modes: [
      {
        id: "custom-safe",
        label: "Custom safe",
        semantic: "custom"
      },
      {
        id: "full-access",
        label: "完全访问",
        semantic: "full-access"
      }
    ]
  });
  assert.deepEqual(options.runtimeContext?.promptCapabilities, {
    image: true
  });
  assert.deepEqual(options.skills, [
    {
      name: "Create App",
      trigger: "create-app",
      sourceKind: "bundled"
    }
  ]);
});

test("desktop agent activity adapter cancels composer options when caller aborts", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(
        _provider,
        _request,
        requestOptions
      ) {
        requestSignal = requestOptions?.signal ?? undefined;
        return await new Promise(() => undefined);
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const load = adapter.loadComposerOptions({
    workspaceId,
    provider: "codex",
    signal: controller.signal
  });
  assert.equal(requestSignal?.aborted, false);

  controller.abort(new Error("caller cancelled"));

  await assert.rejects(load, /caller cancelled/);
  assert.equal(requestSignal?.aborted, true);
});

test("desktop agent activity adapter times out composer options requests", async () => {
  let requestSignal: AbortSignal | undefined;
  const adapter = createDesktopAgentActivityAdapter({
    composerOptionsRequestTimeoutMs: 1,
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(
        _provider,
        _request,
        requestOptions
      ) {
        requestSignal = requestOptions?.signal ?? undefined;
        return await new Promise(() => undefined);
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await assert.rejects(
    adapter.loadComposerOptions({
      workspaceId,
      provider: "claude-code"
    }),
    (error) =>
      error instanceof Error &&
      error.message === "Agent composer options request timed out." &&
      (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
  );
  assert.equal(requestSignal?.aborted, true);
});

test("desktop agent activity adapter sends plan mode when creating sessions", async () => {
  const calls: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(requestWorkspaceId, request) {
        calls.push([requestWorkspaceId, request]);
        return createSession({
          id: request.agentSessionId,
          status: "created"
        });
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const session = await adapter.createSession({
    agentSessionId: "22222222-2222-4222-8222-222222222222",
    agentTargetId: "local:codex",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "hello" }],
    metadata: {
      "": "drop",
      clientSubmitId: "submit-create-1",
      clientSubmittedAtUnixMs: 12345
    },
    model: "gpt-5.5-codex-spark",
    permissionModeId: "read-only",
    planMode: true,
    provider: "codex",
    providerTargetRef: {
      kind: "sharedAgent",
      provider: "codex",
      sharedAgentId: "agent-1"
    },
    reasoningEffort: "high",
    speed: null,
    title: "Plan",
    workspaceId
  });

  assert.equal(session.agentSessionId, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(calls, [
    [
      workspaceId,
      {
        agentSessionId: "22222222-2222-4222-8222-222222222222",
        agentTargetId: "local:codex",
        cwd: "/workspace",
        initialContent: [{ type: "text", text: "hello" }],
        initialDisplayPrompt: null,
        metadata: {
          "": "drop",
          clientSubmitId: "submit-create-1",
          clientSubmittedAtUnixMs: 12345
        },
        model: "gpt-5.5-codex-spark",
        permissionModeId: "read-only",
        planMode: true,
        provider: "codex",
        reasoningEffort: "high",
        speed: null,
        title: "Plan",
        visible: null
      }
    ]
  ]);
});

test("desktop agent activity adapter times out create session requests", async () => {
  let requestSignal: AbortSignal | undefined;
  const adapter = createDesktopAgentActivityAdapter({
    agentSessionCreateRequestTimeoutMs: 1,
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(
        _workspaceId,
        _request,
        requestOptions
      ) {
        requestSignal = requestOptions?.signal ?? undefined;
        return await new Promise(() => undefined);
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await assert.rejects(
    adapter.createSession({
      agentSessionId: "22222222-2222-4222-8222-222222222222",
      agentTargetId: "local:claude-code",
      initialContent: [],
      model: "claude-sonnet-4-20250514",
      provider: "claude-code",
      workspaceId
    }),
    (error) =>
      error instanceof Error &&
      error.message === "Agent session create request timed out." &&
      (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
  );
  assert.equal(requestSignal?.aborted, true);
});

test("desktop agent activity adapter rejects unuploaded file prompt blocks", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession() {
        throw new Error("createWorkspaceAgentSession should not be called");
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await assert.rejects(
    adapter.createSession({
      agentSessionId: "22222222-2222-4222-8222-222222222222",
      initialContent: [
        {
          type: "file",
          hostPath: "/Users/vector/Desktop/notes.txt",
          name: "notes.txt",
          mimeType: "text/plain",
          kind: "file"
        }
      ],
      provider: "codex",
      workspaceId
    }),
    /File prompt blocks must be uploaded before desktop submission/
  );
});

test("desktop agent activity adapter normalizes legacy runtime config options", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider) {
        return {
          provider,
          effectiveSettings: {},
          modelConfig: {
            configurable: true,
            options: []
          },
          permissionConfig: {
            configurable: false,
            modes: []
          },
          reasoningConfig: {
            configurable: true,
            options: []
          },
          runtimeContext: {
            configOptions: [
              {
                id: "model",
                currentValue: "gpt-5.4",
                options: [{ value: "gpt-5.5", name: "GPT-5.5" }]
              },
              {
                id: "reasoning_effort",
                currentValue: "high",
                options: [{ value: "medium", name: "中" }]
              }
            ]
          },
          skills: [],
          capabilityCatalog: []
        };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const options = await adapter.loadComposerOptions({
    workspaceId,
    provider: "codex"
  });

  assert.deepEqual(options.models, [
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.4", label: "gpt-5.4" }
  ]);
  assert.deepEqual(options.reasoningEfforts, [
    { value: "medium", label: "中" },
    { value: "high", label: "high" }
  ]);
});

test("desktop agent activity adapter uses Claude draft live model list", async () => {
  const calls: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider, request) {
        calls.push([provider, request]);
        return {
          provider,
          effectiveSettings: {},
          modelConfig: {
            configurable: true,
            currentValue: "default",
            options: [
              {
                id: "default",
                value: "default",
                label: "Default",
                description: "Opus 4.8 with 1M context"
              },
              {
                id: "claude-opus-4-6",
                value: "claude-opus-4-6",
                label: "Opus 4.6",
                description: "Most capable for complex work"
              }
            ]
          },
          permissionConfig: { configurable: false, modes: [] },
          reasoningConfig: { configurable: false, options: [] },
          runtimeContext: {},
          skills: [],
          capabilityCatalog: []
        };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const options = await adapter.loadComposerOptions({
    workspaceId,
    provider: "claude-code"
  });

  assert.deepEqual(options.models, [
    {
      value: "default",
      label: "Default",
      description: "Opus 4.8 with 1M context"
    },
    {
      value: "claude-opus-4-6",
      label: "Opus 4.6",
      description: "Most capable for complex work"
    }
  ]);
  assert.deepEqual(calls, [["claude-code", { settings: {}, workspaceId }]]);
});

test("desktop agent activity adapter flattens grouped runtime config options", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider) {
        return {
          provider,
          effectiveSettings: {},
          modelConfig: {
            configurable: true,
            currentValue: "sonnet",
            options: []
          },
          permissionConfig: { configurable: false, modes: [] },
          reasoningConfig: { configurable: false, options: [] },
          runtimeContext: {
            configOptions: [
              {
                id: "model",
                currentValue: "sonnet",
                options: [
                  {
                    group: "claude",
                    name: "Claude",
                    options: [
                      {
                        value: "sonnet",
                        name: "Sonnet",
                        description: "Best for everyday tasks"
                      }
                    ]
                  }
                ]
              }
            ]
          },
          skills: [],
          capabilityCatalog: []
        };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const options = await adapter.loadComposerOptions({
    workspaceId,
    provider: "claude-code"
  });

  assert.deepEqual(options.models, [
    {
      value: "sonnet",
      label: "Sonnet",
      description: "Best for everyday tasks"
    }
  ]);
});

test("desktop agent activity adapter loads Claude models via composer options request", async () => {
  const composerOptionsCalls: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider, request) {
        composerOptionsCalls.push({ provider, request });
        return {
          provider,
          effectiveSettings: {},
          modelConfig: {
            configurable: true,
            currentValue: "default",
            options: [
              {
                id: "default",
                value: "default",
                label: "Default",
                description: "Opus 4.8 with 1M context"
              },
              {
                id: "opus",
                value: "opus",
                label: "Opus",
                description: "Most capable"
              }
            ]
          },
          permissionConfig: { configurable: false, modes: [] },
          reasoningConfig: { configurable: false, options: [] },
          runtimeContext: {},
          skills: [],
          capabilityCatalog: []
        };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const options = await adapter.loadComposerOptions({
    cwd: "/repo",
    provider: "claude-code",
    workspaceId
  });

  assert.deepEqual(composerOptionsCalls, [
    {
      provider: "claude-code",
      request: { cwd: "/repo", settings: {}, workspaceId }
    }
  ]);
  assert.equal(options.modelConfigurable, true);
  assert.deepEqual(options.models, [
    {
      value: "default",
      label: "Default",
      description: "Opus 4.8 with 1M context"
    },
    { value: "opus", label: "Opus", description: "Most capable" }
  ]);
});

test("desktop agent activity adapter promotes Claude draft on first prompt", async () => {
  const calls: string[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, request) {
        calls.push(
          `create:${request.visible === false ? "hidden" : "visible"}`
        );
        return createSession({
          id: request.agentSessionId,
          provider: "claude-code",
          runtimeContext: {
            configOptions: [
              {
                id: "model",
                currentValue: "opus",
                options: [{ value: "opus", name: "Opus" }]
              }
            ]
          },
          visible: false
        });
      },
      async updateWorkspaceAgentSessionVisibility(
        _workspaceId,
        agentSessionId,
        request
      ) {
        calls.push(`visibility:${agentSessionId}:${request.visible}`);
        return createSession({
          id: agentSessionId,
          provider: "claude-code",
          visible: request.visible
        });
      },
      async sendWorkspaceAgentSessionInput(
        _workspaceId,
        agentSessionId,
        request
      ) {
        calls.push(`send:${agentSessionId}:${request.content[0]?.text}`);
        return createSendInputResponse(
          createSession({
            id: agentSessionId,
            provider: "claude-code",
            status: "running",
            visible: true
          })
        );
      }
    }),
    runtimeApi: createRuntimeApi()
  });
  const options = await adapter.loadComposerOptions({
    agentTargetId: "local:claude-code",
    provider: "claude-code",
    workspaceId
  });
  const draftAgentSessionId = String(
    options.runtimeContext?.draftAgentSessionId
  );

  const session = await adapter.createSession({
    agentSessionId: draftAgentSessionId,
    agentTargetId: "local:claude-code",
    initialContent: [{ type: "text", text: "hello" }],
    provider: "claude-code",
    workspaceId
  });

  assert.deepEqual(calls, [
    "create:hidden",
    `visibility:${draftAgentSessionId}:true`,
    `send:${draftAgentSessionId}:hello`
  ]);
  assert.equal(session.agentSessionId, draftAgentSessionId);
  assert.equal(session.status, "running");
  assert.equal(session.visible, true);
});

test("desktop agent activity adapter forwards agent target id when creating Claude drafts", async () => {
  const createRequests: unknown[] = [];
  const calls: string[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, request) {
        createRequests.push(request);
        calls.push(
          `create:${request.visible === false ? "hidden" : "visible"}`
        );
        return createSession({
          id: request.agentSessionId,
          provider: "claude-code",
          visible: false
        });
      },
      async updateWorkspaceAgentSessionVisibility(
        _workspaceId,
        agentSessionId,
        request
      ) {
        calls.push(`visibility:${agentSessionId}:${request.visible}`);
        return createSession({
          id: agentSessionId,
          provider: "claude-code",
          visible: request.visible
        });
      },
      async sendWorkspaceAgentSessionInput(
        _workspaceId,
        agentSessionId,
        request
      ) {
        calls.push(`send:${agentSessionId}:${request.content[0]?.text}`);
        return createSendInputResponse(
          createSession({
            id: agentSessionId,
            provider: "claude-code",
            status: "running",
            visible: true
          })
        );
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const session = await adapter.createSession({
    agentSessionId: "22222222-2222-4222-8222-222222222222",
    agentTargetId: "shared-agent:claude-1",
    initialContent: [{ type: "text", text: "hello" }],
    provider: "claude-code",
    workspaceId
  });

  assert.deepEqual(createRequests, [
    {
      agentSessionId: "22222222-2222-4222-8222-222222222222",
      agentTargetId: "shared-agent:claude-1",
      cwd: null,
      initialContent: [],
      model: null,
      permissionModeId: null,
      planMode: null,
      provider: "claude-code",
      reasoningEffort: null,
      speed: null,
      title: null,
      visible: false
    }
  ]);
  assert.deepEqual(calls, [
    "create:hidden",
    "visibility:22222222-2222-4222-8222-222222222222:true",
    "send:22222222-2222-4222-8222-222222222222:hello"
  ]);
  assert.equal(session.agentSessionId, "22222222-2222-4222-8222-222222222222");
});

test("desktop agent activity adapter uses a fresh Claude draft id after target switches", async () => {
  const fixedAgentSessionId = "22222222-2222-4222-8222-222222222222";
  const createRequests: unknown[] = [];
  const calls: string[] = [];
  const firstAgentTargetId = "shared-agent:claude-1";
  const secondAgentTargetId = "shared-agent:claude-2";
  let resolveFirstDraft: ((session: WorkspaceAgentSession) => void) | undefined;
  const firstDraft = new Promise<WorkspaceAgentSession>((resolve) => {
    resolveFirstDraft = resolve;
  });
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, request) {
        createRequests.push(request);
        if (createRequests.length === 1) {
          return await firstDraft;
        }
        return createSession({
          id: request.agentSessionId,
          provider: "claude-code",
          visible: false
        });
      },
      async deleteWorkspaceAgentSession(_workspaceId, agentSessionId) {
        calls.push(`delete:${agentSessionId}`);
        return { removed: true };
      },
      async updateWorkspaceAgentSessionVisibility(
        _workspaceId,
        agentSessionId,
        request
      ) {
        calls.push(`visibility:${agentSessionId}:${request.visible}`);
        return createSession({
          id: agentSessionId,
          provider: "claude-code",
          visible: request.visible
        });
      },
      async sendWorkspaceAgentSessionInput(
        _workspaceId,
        agentSessionId,
        request
      ) {
        calls.push(`send:${agentSessionId}:${request.content[0]?.text}`);
        return createSendInputResponse(
          createSession({
            id: agentSessionId,
            provider: "claude-code",
            status: "running",
            visible: true
          })
        );
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const firstSubmission = adapter.createSession({
    agentSessionId: fixedAgentSessionId,
    agentTargetId: firstAgentTargetId,
    initialContent: [{ type: "text", text: "first" }],
    provider: "claude-code",
    workspaceId
  });
  await waitForCondition(
    () => createRequests.length === 1,
    "expected the first Claude draft request to start"
  );

  const session = await adapter.createSession({
    agentSessionId: fixedAgentSessionId,
    agentTargetId: secondAgentTargetId,
    initialContent: [{ type: "text", text: "second" }],
    provider: "claude-code",
    workspaceId
  });

  assert.equal(createRequests.length, 2);
  assert.equal(
    (createRequests[0] as { agentSessionId?: string }).agentSessionId,
    fixedAgentSessionId
  );
  const replacementAgentSessionId = (
    createRequests[1] as { agentSessionId?: string }
  ).agentSessionId;
  assert.notEqual(replacementAgentSessionId, fixedAgentSessionId);
  assert.deepEqual(
    (createRequests[1] as { agentTargetId?: unknown }).agentTargetId,
    secondAgentTargetId
  );
  assert.deepEqual(calls, [
    `visibility:${replacementAgentSessionId}:true`,
    `send:${replacementAgentSessionId}:second`
  ]);
  assert.equal(session.agentSessionId, replacementAgentSessionId);

  resolveFirstDraft?.(
    createSession({
      id: fixedAgentSessionId,
      provider: "claude-code",
      visible: false
    })
  );
  await firstSubmission;
  await waitForCondition(
    () => calls.includes(`delete:${fixedAgentSessionId}`),
    "expected the stale Claude draft from the previous target to be deleted"
  );
});

test("desktop agent activity adapter loads Claude options without mutating draft sessions", async () => {
  const calls: string[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider, request) {
        calls.push(
          `options:${provider}:${String(request?.settings?.planMode)}`
        );
        return {
          provider,
          effectiveSettings: request?.settings ?? {},
          modelConfig: { configurable: true, options: [] },
          permissionConfig: { configurable: false, modes: [] },
          reasoningConfig: { configurable: true, options: [] },
          runtimeContext: {},
          skills: [],
          capabilityCatalog: []
        };
      },
      async createWorkspaceAgentSession(_workspaceId, request) {
        calls.push(`create:${request.planMode === true ? "plan" : "default"}`);
        return createSession({
          id: request.agentSessionId,
          provider: "claude-code",
          visible: false
        });
      },
      async updateWorkspaceAgentSessionSettings(
        _workspaceId,
        agentSessionId,
        request
      ) {
        calls.push(`update:${agentSessionId}:plan=${String(request.planMode)}`);
        return createSession({
          id: agentSessionId,
          provider: "claude-code",
          visible: false
        });
      },
      async deleteWorkspaceAgentSession(_workspaceId, agentSessionId) {
        calls.push(`delete:${agentSessionId}`);
        return { removed: true };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await adapter.loadComposerOptions({
    provider: "claude-code",
    settings: { planMode: false },
    workspaceId
  });

  await adapter.loadComposerOptions({
    provider: "claude-code",
    settings: { planMode: true },
    workspaceId
  });

  assert.deepEqual(calls, [
    "options:claude-code:false",
    "options:claude-code:true"
  ]);
});

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
    async listWorkspaceAgentSessionMessages() {
      return {
        agentSessionId: "agent-session-1",
        hasMore: false,
        latestVersion: 0,
        messages: []
      };
    },
    async listWorkspaceAgentSessions() {
      return { sessions: [createSession()], workspaceId };
    },
    async getAgentProviderComposerOptions() {
      return {
        provider: "codex",
        effectiveSettings: {},
        modelConfig: {
          configurable: true,
          options: []
        },
        permissionConfig: {
          configurable: false,
          modes: []
        },
        reasoningConfig: {
          configurable: true,
          options: []
        },
        runtimeContext: {},
        skills: [],
        capabilityCatalog: []
      };
    },
    async submitWorkspaceAgentInteractive() {
      return createSession();
    },
    async sendWorkspaceAgentSessionInput() {
      return createSendInputResponse(createSession({ status: "running" }));
    },
    async updateWorkspaceAgentSessionVisibility(
      _workspaceId: string,
      agentSessionId: string,
      request: { visible: boolean }
    ) {
      return createSession({ id: agentSessionId, visible: request.visible });
    },
    ...overrides
  } as unknown as TuttidClient;
}

function createRuntimeApi(diagnostics: unknown[] = []) {
  return {
    logTerminalDiagnostic(payload: unknown) {
      diagnostics.push(payload);
      return Promise.resolve();
    }
  };
}

function unknownPermissionModeSemantic(value: string): PermissionModeSemantic {
  return value as unknown as PermissionModeSemantic;
}

async function waitForCondition(
  condition: () => boolean,
  message: string
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function createSession(
  overrides: Partial<WorkspaceAgentSession> = {}
): WorkspaceAgentSession {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/",
    id: "agent-session-1",
    provider: "codex",
    status: "running",
    title: "Agent session",
    updatedAt: "2026-01-01T00:01:00.000Z",
    visible: true,
    ...overrides
  };
}

function createSendInputResponse(session: WorkspaceAgentSession) {
  return {
    session,
    turnId: "turn-1",
    turnLifecycle: {
      activeTurnId: "turn-1",
      phase: "submitted"
    },
    submitAvailability: {
      reason: "active_turn",
      state: "blocked"
    }
  };
}

function createMessage(
  overrides: Partial<WorkspaceAgentSessionMessage> = {}
): WorkspaceAgentSessionMessage {
  return {
    agentSessionId: "agent-session-1",
    id: 1,
    kind: "text",
    messageId: "message-1",
    occurredAtUnixMs: 1717200001000,
    payload: {},
    role: "assistant",
    turnId: "turn-1",
    version: 1,
    ...overrides
  };
}
