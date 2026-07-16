import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateWorkspaceAgentSessionRequest,
  TuttidClient,
  PermissionModeSemantic,
  SendWorkspaceAgentSessionInputRequest,
  SendWorkspaceAgentSessionInputResponse,
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage
} from "@tutti-os/client-tuttid-ts";
import { TuttidProtocolError } from "@tutti-os/client-tuttid-ts";
import {
  agentActivityMessageFromTuttidMessage,
  agentActivitySessionFromTuttidSession,
  createDesktopAgentActivityAdapter
} from "./desktopAgentActivityAdapter.ts";

const workspaceId = "workspace-1";

test("desktop agent activity adapter preserves durable message sequence", () => {
  const message = agentActivityMessageFromTuttidMessage(
    workspaceId,
    createMessage({
      sequence: 42,
      createdAtUnixMs: 100
    })
  );

  assert.equal(message.sequence, 42);
  assert.equal(message.createdAtUnixMs, 100);
});

test("desktop agent activity adapter rejects missing protocol v2 session fields", () => {
  for (const field of [
    "activeTurnId",
    "latestTurnInteractions",
    "pendingInteractions",
    "railSectionKey",
    "tuttiModeActivation"
  ] as const) {
    const malformed = { ...createSession() } as Record<string, unknown>;
    delete malformed[field];
    assert.throws(
      () =>
        agentActivitySessionFromTuttidSession(
          workspaceId,
          malformed as WorkspaceAgentSession
        ),
      new RegExp(`Protocol v2 contract error:.*${field}`)
    );
  }
});

test("desktop agent activity adapter rejects a blank rail section key", () => {
  assert.throws(
    () =>
      agentActivitySessionFromTuttidSession(
        workspaceId,
        createSession({ railSectionKey: "  " })
      ),
    /railSectionKey must be a non-empty string/
  );
});

test("desktop agent activity adapter preserves a settled latest turn on reload", () => {
  const latestTurn = {
    agentSessionId: "agent-session-1",
    completedCommand: null,
    error: null,
    fileChanges: null,
    origin: "goal_continuation" as const,
    outcome: "failed" as const,
    phase: "settled" as const,
    settledAtUnixMs: 30,
    sourceGoalOperationId: "goal-operation-1",
    sourceGoalRepairEpoch: 4,
    sourceGoalRevision: 7,
    startedAtUnixMs: 10,
    turnId: "turn-1",
    updatedAtUnixMs: 30
  };
  const session = agentActivitySessionFromTuttidSession(
    workspaceId,
    createSession({
      activeTurn: null,
      activeTurnId: null,
      latestTurn,
      latestTurnInteractions: [
        {
          requestId: "request-1",
          agentSessionId: "agent-session-1",
          turnId: "turn-1",
          kind: "question",
          input: null,
          metadata: null,
          output: null,
          status: "answered",
          toolName: null,
          createdAtUnixMs: 20,
          updatedAtUnixMs: 30
        }
      ]
    })
  );
  assert.equal(session.activeTurn, null);
  assert.equal(session.activeTurnId, null);
  assert.deepEqual(session.latestTurn, latestTurn);
  assert.equal(session.latestTurnInteractions?.[0]?.status, "answered");
});

test("desktop agent activity adapter maps typed canonical session control fields", () => {
  const session = agentActivitySessionFromTuttidSession(
    workspaceId,
    createSession({
      capabilities: {
        activeTurnGuidance: false,
        browserUse: false,
        compact: true,
        computerUse: false,
        goalPause: false,
        imageInput: false,
        interrupt: false,
        modelImageInputRequired: false,
        modelPlanBinding: false,
        modelSwitch: false,
        permissionModeChangeDeferred: false,
        permissionModeChangeDuringTurn: false,
        planImplementation: false,
        planMode: true,
        rateLimits: false,
        resumeRunningTurn: false,
        review: false,
        skills: false,
        tokenUsage: false
      },
      createdAtUnixMs: 10,
      endedAtUnixMs: 30,
      goal: { objective: "Ship it", status: "active" },
      imported: true,
      railSectionKey: "project:repo-1",
      permissionConfig: {
        configurable: true,
        defaultValue: "ask",
        modes: [
          {
            id: "ask",
            label: "Ask",
            semantic: "ask-before-write"
          }
        ]
      },
      settings: { model: "gpt-5", planMode: true },
      usage: {
        contextWindow: { usedTokens: 7_460, totalTokens: 200_000 },
        quotas: []
      },
      updatedAtUnixMs: 20
    })
  );

  assert.equal(session.capabilities?.compact, true);
  assert.equal(session.capabilities?.planMode, true);
  assert.equal(session.createdAtUnixMs, 10);
  assert.equal(session.endedAtUnixMs, 30);
  assert.deepEqual(session.goal, { objective: "Ship it", status: "active" });
  assert.equal(session.imported, true);
  assert.equal(session.railSectionKey, "project:repo-1");
  assert.equal(session.permissionConfig?.defaultValue, "ask");
  assert.deepEqual(session.settings, { model: "gpt-5", planMode: true });
  assert.deepEqual(session.usage, {
    contextWindow: { usedTokens: 7_460, totalTokens: 200_000 },
    quotas: []
  });
  assert.equal(session.updatedAtUnixMs, 20);
  assert.equal("runtimeContext" in session, false);
  assert.equal("lastError" in session, false);
});

test("desktop agent activity adapter maps tuttid sessions and messages", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const diagnostics: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async listWorkspaceAgentSessions(
        requestWorkspaceId: string,
        request?: { limit?: number; searchQuery?: string }
      ) {
        calls.push({
          args: [requestWorkspaceId, request],
          method: "listSessions"
        });
        return {
          hasMore: false,
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
  assert.equal(sessions.sessions[0]?.agentSessionId, "agent-session-1");
  assert.equal(sessions.sessions[0]?.activeTurn?.phase, "waiting");
  assert.equal(sessions.sessions[0]?.title, "Review");
  assert.equal(sessions.sessions[0]?.workspaceId, workspaceId);
  assert.deepEqual(messages, {
    hasMore: false,
    latestVersion: 5,
    messages: [
      {
        agentSessionId: "agent-session-1",
        completedAtUnixMs: 1717200003000,
        createdAtUnixMs: undefined,
        kind: "text",
        messageId: "message-5",
        occurredAtUnixMs: 1717200001000,
        payload: { text: "hello" },
        role: "assistant",
        sequence: 1,
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

test("desktop agent activity adapter preserves session-level turnless messages", async () => {
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

  const result = await adapter.listSessionMessages({
    agentSessionId: "agent-session-1",
    workspaceId
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.messageId, "message-without-turn");
  assert.equal(result.messages[0]?.turnId, null);
});

test("desktop agent activity adapter forwards typed submit diagnostics", async () => {
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
    clientSubmitId: "submit-1",
    workspaceId,
    agentSessionId: "agent-session-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    content: [{ type: "text", text: "hello" }],
    guidance: true,
    submitDiagnostics: {
      submittedAtUnixMs: 1234,
      source: "agent-gui"
    }
  });

  assert.deepEqual(calls, [
    {
      agentSessionId: "agent-session-1",
      request: {
        capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
        clientSubmitId: "submit-1",
        content: [{ type: "text", text: "hello" }],
        displayPrompt: null,
        guidance: true,
        submitDiagnostics: {
          submittedAtUnixMs: 1234,
          source: "agent-gui"
        }
      } satisfies SendWorkspaceAgentSessionInputRequest,
      workspaceId
    }
  ]);
});

test("desktop agent activity adapter rejects send responses without a canonical turn", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async sendWorkspaceAgentSessionInput(
        _requestWorkspaceId,
        agentSessionId
      ) {
        const { turn: _turn, ...response } = createSendInputResponse(
          createSession({ id: agentSessionId, status: "running" })
        );
        return response as unknown as SendWorkspaceAgentSessionInputResponse;
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await assert.rejects(
    adapter.sendInput({
      clientSubmitId: "submit-missing-turn",
      workspaceId,
      agentSessionId: "agent-session-1",
      content: [{ type: "text", text: "hello" }]
    }),
    /workspace_agent\.send_response_turn_required/
  );
});

test("desktop agent activity adapter accepts typed goal input without a Turn", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async sendWorkspaceAgentSessionInput(
        _requestWorkspaceId,
        agentSessionId
      ) {
        const session = createSession({
          id: agentSessionId,
          goal: { objective: "ship it", status: "active" }
        });
        return {
          kind: "goalControl" as const,
          operationId: "goal-op-1",
          session,
          goal: session.goal
        };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const result = await adapter.sendInput({
    clientSubmitId: "submit-goal",
    workspaceId,
    agentSessionId: "agent-session-1",
    content: [{ type: "text", text: "/goal ship it" }]
  });

  assert.equal(result.kind, "goalControl");
  assert.equal(result.session.activeTurnId, null);
  if (result.kind !== "goalControl") {
    throw new Error("expected goal control result");
  }
  assert.equal(result.goal?.objective, "ship it");
});

test("desktop agent activity adapter marks empty-cwd creates as no-project", async () => {
  let createBody: unknown = null;
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, body) {
        createBody = body;
        return createSession({
          cwd: "/Users/local/Documents/tutti/session-agent-session-1"
        });
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await adapter.createSession({
    clientSubmitId: "submit-no-project",
    agentSessionId: "agent-session-1",
    agentTargetId: "local:codex",
    initialContent: [{ type: "text", text: "hi" }],
    workspaceId
  });

  assert.deepEqual((createBody as { noProject?: boolean }).noProject, true);
});

test("desktop agent activity adapter creates, projects, and revision-updates the independent Tutti activation", async () => {
  const activeActivation = {
    agentSessionId: "agent-session-1",
    createdAtUnixMs: 10,
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 10,
      id: "revision-1",
      revision: 1,
      source: "slash_command" as const,
      status: "active" as const
    },
    id: "activation-1",
    status: "active" as const,
    updatedAtUnixMs: 10,
    workspaceId
  };
  const inactiveActivation = {
    ...activeActivation,
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 20,
      id: "revision-2",
      revision: 2,
      source: "badge_remove" as const,
      status: "inactive" as const
    },
    status: "inactive" as const,
    updatedAtUnixMs: 20
  };
  const createBodies: CreateWorkspaceAgentSessionRequest[] = [];
  let updateCall: unknown = null;
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, body) {
        createBodies.push(body);
        return createSession({
          id: body.agentSessionId,
          tuttiModeActivation: activeActivation
        });
      },
      async updateWorkspaceAgentSessionTuttiModeActivation(
        updateWorkspaceId,
        agentSessionId,
        request,
        requestOptions
      ) {
        updateCall = {
          agentSessionId,
          request,
          signal: requestOptions?.signal,
          workspaceId: updateWorkspaceId
        };
        return { activation: inactiveActivation, changed: true };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const created = await adapter.createSession({
    agentSessionId: "agent-session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-tutti",
    initialTuttiModeActivation: {
      source: "slash_command",
      status: "active"
    },
    workspaceId
  });
  assert.deepEqual(createBodies[0]?.initialTuttiModeActivation, {
    source: "slash_command",
    status: "active"
  });
  assert.deepEqual(created.tuttiModeActivation, activeActivation);

  const controller = new AbortController();
  const updated = await adapter.updateTuttiModeActivation({
    agentSessionId: "agent-session-1",
    expectedRevision: 1,
    signal: controller.signal,
    source: "badge_remove",
    status: "inactive",
    workspaceId
  });
  assert.deepEqual(updateCall, {
    agentSessionId: "agent-session-1",
    request: {
      expectedRevision: 1,
      source: "badge_remove",
      status: "inactive"
    },
    signal: controller.signal,
    workspaceId
  });
  assert.deepEqual(updated, {
    activation: inactiveActivation,
    changed: true
  });
});

test("desktop agent activity adapter forwards HTTPS image URLs structurally", async () => {
  let createBody: unknown = null;
  const url = "https://bucket.example/image.png?X-Amz-Signature=secret";
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, body) {
        createBody = body;
        return createSession({ id: body.agentSessionId, status: "created" });
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await adapter.createSession({
    agentSessionId: "22222222-2222-4222-8222-222222222222",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-remote-image",
    initialContent: [
      {
        type: "image",
        mimeType: "image/png",
        url,
        attachmentId: "remote-image",
        name: "image.png"
      }
    ],
    workspaceId
  });

  assert.deepEqual(
    (createBody as { initialContent?: unknown }).initialContent,
    [
      {
        type: "image",
        mimeType: "image/png",
        url,
        attachmentId: "remote-image",
        name: "image.png"
      }
    ]
  );
});

test("desktop agent activity adapter localizes adapter mismatch create failures", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession() {
        throw new TuttidProtocolError({
          code: "workspace_operation_failed",
          developerMessage: "opencode: ACP adapter not found",
          reason: "acp_adapter_version_mismatch",
          statusCode: 502
        });
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  await assert.rejects(
    adapter.createSession({
      clientSubmitId: "submit-adapter-mismatch",
      agentSessionId: "agent-session-1",
      agentTargetId: "local:opencode",
      workspaceId
    }),
    /The local agent adapter is unavailable or version-mismatched/
  );
});

test("desktop agent activity adapter passes through unrelated create failures", async () => {
  const adapter = createDesktopAgentActivityAdapter({
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
      clientSubmitId: "submit-service-unavailable",
      agentSessionId: "agent-session-1",
      agentTargetId: "local:claude-code",
      workspaceId
    }),
    /service_unavailable|TuttidProtocolError|tuttid unavailable/
  );
});

test("desktop agent activity adapter leaves session event subscription to the service runtime", () => {
  const diagnostics: unknown[] = [];
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient(),
    runtimeApi: createRuntimeApi(diagnostics)
  });

  assert.equal("subscribeSessionEvents" in adapter, false);
  assert.deepEqual(diagnostics, []);
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

  const result = await adapter.submitInteractive({
    agentSessionId: "agent-session-1",
    optionId: "acceptEdits",
    payload: { path: "/Users/example/demo/src/styles.css" },
    requestId: "interactive-1",
    turnId: "turn-1",
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
        payload: { path: "/Users/example/demo/src/styles.css" },
        turnId: "turn-1"
      }
    ]
  ]);
  assert.equal(result.session.workspaceId, workspaceId);
  assert.equal(result.session.agentSessionId, "agent-session-1");
  assert.equal(result.session.activeTurn?.phase, "waiting");
});

test("desktop agent activity adapter normalizes provider composer options", async () => {
  const calls: unknown[] = [];
  const diagnostics: unknown[] = [];
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
          skills: [
            {
              name: "Create App",
              trigger: "create-app",
              sourceKind: "bundled"
            }
          ],
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilities: {
            activeTurnGuidance: true,
            browserUse: true,
            compact: false,
            computerUse: false,
            goalPause: false,
            imageInput: true,
            interrupt: true,
            modelImageInputRequired: true,
            modelPlanBinding: true,
            modelSwitch: false,
            permissionModeChangeDeferred: false,
            permissionModeChangeDuringTurn: false,
            planImplementation: false,
            planMode: true,
            rateLimits: false,
            resumeRunningTurn: false,
            review: false,
            skills: false,
            tokenUsage: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: [],
          runtimeContext: {}
        };
      }
    }),
    runtimeApi: createRuntimeApi(diagnostics)
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
  assert.deepEqual(options.skills, [
    {
      name: "Create App",
      trigger: "create-app",
      sourceKind: "bundled"
    }
  ]);
  assert.equal(options.capabilities?.planMode, true);
  assert.equal(options.capabilities?.browserUse, true);
  assert.equal(options.capabilities?.activeTurnGuidance, true);
  assert.equal(options.capabilities?.modelPlanBinding, true);
  assert.equal(diagnostics.length, 1);
  const diagnostic = diagnostics[0] as {
    details: Record<string, unknown>;
    event: string;
    level: string;
    workspaceId: string;
  };
  assert.equal(diagnostic.event, "agent.composer_options.load");
  assert.equal(diagnostic.level, "info");
  assert.equal(diagnostic.workspaceId, workspaceId);
  assert.deepEqual(
    { ...diagnostic.details, durationMs: typeof diagnostic.details.durationMs },
    {
      agentTargetId: null,
      durationMs: "number",
      provider: "codex",
      status: "ready"
    }
  );
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
    clientSubmitId: "submit-create-1",
    agentSessionId: "22222222-2222-4222-8222-222222222222",
    agentTargetId: "local:codex",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "hello" }],
    submitDiagnostics: {
      blockCount: 1,
      submittedAtUnixMs: 12345,
      source: "agent-gui"
    },
    model: "gpt-5.5-codex-spark",
    permissionModeId: "read-only",
    planMode: true,
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
        clientSubmitId: "submit-create-1",
        cwd: "/workspace",
        initialContent: [{ type: "text", text: "hello" }],
        initialDisplayPrompt: null,
        submitDiagnostics: {
          blockCount: 1,
          submittedAtUnixMs: 12345,
          source: "agent-gui"
        },
        model: "gpt-5.5-codex-spark",
        noProject: null,
        permissionModeId: "read-only",
        planMode: true,
        reasoningEffort: "high",
        speed: null,
        title: "Plan",
        visible: null
      } satisfies CreateWorkspaceAgentSessionRequest
    ]
  ]);
});

test("desktop agent activity adapter forwards create cancellation from the engine", async () => {
  let requestSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(
        _workspaceId,
        _request,
        requestOptions
      ) {
        requestSignal = requestOptions?.signal ?? undefined;
        return await new Promise((_resolve, reject) => {
          requestOptions?.signal?.addEventListener(
            "abort",
            () => reject(requestOptions.signal?.reason),
            { once: true }
          );
        });
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const request = adapter.createSession({
    clientSubmitId: "submit-timeout",
    agentSessionId: "22222222-2222-4222-8222-222222222222",
    agentTargetId: "local:claude-code",
    initialContent: [],
    model: "claude-sonnet-4-20250514",
    workspaceId,
    signal: controller.signal
  });
  controller.abort(new Error("engine command timed out"));
  await assert.rejects(request, /engine command timed out/);
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
      clientSubmitId: "submit-file",
      agentSessionId: "22222222-2222-4222-8222-222222222222",
      agentTargetId: "local:codex",
      initialContent: [
        {
          type: "file",
          hostPath: "/Users/vector/Desktop/notes.txt",
          name: "notes.txt",
          mimeType: "text/plain",
          kind: "file"
        }
      ],
      workspaceId
    }),
    /File prompt blocks must be uploaded before desktop submission/
  );
});

test("desktop agent activity adapter ignores legacy runtime model and reasoning options", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider) {
        return {
          provider,
          effectiveSettings: {},
          modelConfig: {
            configurable: true,
            currentValue: "gpt-5.4",
            options: []
          },
          permissionConfig: {
            configurable: false,
            modes: []
          },
          reasoningConfig: {
            configurable: true,
            options: [
              { id: "low", value: "low", label: "Low" },
              { id: "ultra", value: "ultra", label: "Ultra" }
            ]
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
                options: [
                  { value: "medium", name: "中" },
                  { value: "ultra", name: "ultra" }
                ]
              }
            ]
          },
          skills: [],
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
        };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const options = await adapter.loadComposerOptions({
    workspaceId,
    provider: "codex"
  });

  // This branch's daemon contract emits the legacy modelConfig shape; the
  // runtimeContext.configOptions list stays ignored. The current value is not
  // in the advertised list; the projection keeps it selectable but marks it
  // requested-origin (not catalog testimony).
  assert.deepEqual(options.models, [
    { value: "gpt-5.4", label: "gpt-5.4", requested: true }
  ]);
  assert.deepEqual(options.reasoningEfforts, [
    { value: "low", label: "Low" },
    { value: "ultra", label: "Ultra" }
  ]);
});

test("desktop agent activity adapter preserves ACP labels over synthesized config labels", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider) {
        return {
          provider,
          effectiveSettings: {},
          modelConfig: { configurable: true, options: [] },
          permissionConfig: { configurable: false, modes: [] },
          reasoningConfig: {
            configurable: true,
            currentValue: "ultra",
            options: [{ id: "ultra", value: "ultra", label: "ACP Ultra" }]
          },
          runtimeContext: {
            configOptions: [
              {
                id: "reasoning_effort",
                currentValue: "ultra",
                options: [{ value: "ultra", name: "Legacy Ultra" }]
              }
            ]
          },
          skills: [],
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
        };
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const options = await adapter.loadComposerOptions({
    workspaceId,
    provider: "codex"
  });

  assert.deepEqual(options.reasoningEfforts, [
    { value: "ultra", label: "ACP Ultra" }
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
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
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

test("desktop agent activity adapter preserves typed model metadata over legacy runtime options", async () => {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async getAgentProviderComposerOptions(provider) {
        return {
          provider,
          effectiveSettings: {},
          modelConfig: {
            configurable: true,
            currentValue: "sonnet",
            options: [
              {
                id: "sonnet",
                value: "sonnet",
                label: "Sonnet",
                description: "Best for everyday tasks",
                supportsImageInput: true
              }
            ]
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
                        name: "Legacy Sonnet"
                      }
                    ]
                  }
                ]
              }
            ]
          },
          skills: [],
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
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
      description: "Best for everyday tasks",
      supportsImageInput: true
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
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
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

test("desktop agent activity adapter creates a visible target-backed Claude session on first prompt", async () => {
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

  const session = await adapter.createSession({
    clientSubmitId: "submit-claude-draft",
    agentSessionId: "22222222-2222-4222-8222-222222222222",
    agentTargetId: "local:claude-code",
    initialContent: [{ type: "text", text: "hello" }],
    workspaceId
  });

  assert.deepEqual(calls, ["create:visible"]);
  assert.equal(session.agentSessionId, "22222222-2222-4222-8222-222222222222");
  assert.equal(session.activeTurn, null);
  assert.equal(session.visible, false);
});

test("desktop agent activity adapter forwards agent target id when creating Claude sessions", async () => {
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
    clientSubmitId: "submit-shared-claude",
    agentSessionId: "22222222-2222-4222-8222-222222222222",
    agentTargetId: "shared-agent:claude-1",
    initialContent: [{ type: "text", text: "hello" }],
    workspaceId
  });

  assert.deepEqual(createRequests, [
    {
      agentSessionId: "22222222-2222-4222-8222-222222222222",
      agentTargetId: "shared-agent:claude-1",
      clientSubmitId: "submit-shared-claude",
      cwd: null,
      initialContent: [{ type: "text", text: "hello" }],
      initialDisplayPrompt: null,
      model: null,
      permissionModeId: null,
      planMode: null,
      reasoningEffort: null,
      noProject: true,
      speed: null,
      title: null,
      visible: null
    }
  ]);
  assert.deepEqual(calls, ["create:visible"]);
  assert.equal(session.agentSessionId, "22222222-2222-4222-8222-222222222222");
});

test("desktop agent activity adapter preserves requested session ids across target switches", async () => {
  const fixedAgentSessionId = "22222222-2222-4222-8222-222222222222";
  const createRequests: unknown[] = [];
  const firstAgentTargetId = "shared-agent:claude-1";
  const secondAgentTargetId = "shared-agent:claude-2";
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: createTuttidClient({
      async createWorkspaceAgentSession(_workspaceId, request) {
        createRequests.push(request);
        return createSession({
          id: request.agentSessionId,
          provider: "claude-code",
          visible: true
        });
      }
    }),
    runtimeApi: createRuntimeApi()
  });

  const firstSession = await adapter.createSession({
    clientSubmitId: "submit-first",
    agentSessionId: fixedAgentSessionId,
    agentTargetId: firstAgentTargetId,
    initialContent: [{ type: "text", text: "first" }],
    workspaceId
  });

  const secondSession = await adapter.createSession({
    clientSubmitId: "submit-second",
    agentSessionId: fixedAgentSessionId,
    agentTargetId: secondAgentTargetId,
    initialContent: [{ type: "text", text: "second" }],
    workspaceId
  });

  assert.equal(createRequests.length, 2);
  assert.equal(
    (createRequests[0] as { agentSessionId?: string }).agentSessionId,
    fixedAgentSessionId
  );
  assert.equal(
    (createRequests[1] as { agentSessionId?: string }).agentSessionId,
    fixedAgentSessionId
  );
  assert.deepEqual(
    (createRequests[1] as { agentTargetId?: unknown }).agentTargetId,
    secondAgentTargetId
  );
  assert.equal(firstSession.agentSessionId, fixedAgentSessionId);
  assert.equal(secondSession.agentSessionId, fixedAgentSessionId);
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
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
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
        return { cleanupFailed: false, removed: true };
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
      return { hasMore: false, sessions: [createSession()], workspaceId };
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
        behavior: {
          collapseModelOptionsToLatest: false,
          modelOptionsAuthoritative: false,
          refreshModelOptionsAfterSettings: false,
          prewarmDraftSession: false,
          planModeExclusiveWithPermissionMode: false
        },
        capabilityCatalog: [],
        reasoningOptionsByModel: {},
        commands: []
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

function createSession(
  overrides: Partial<WorkspaceAgentSession> & {
    createdAt?: string;
    endedAt?: string | null;
    lastError?: string | null;
    runtimeContext?: Record<string, unknown>;
    status?: string;
    updatedAt?: string;
  } = {}
): WorkspaceAgentSession {
  const {
    createdAt,
    endedAt,
    lastError: _lastError,
    runtimeContext: _runtimeContext,
    status,
    updatedAt,
    ...canonicalOverrides
  } = overrides;
  const createdAtUnixMs = createdAt ? Date.parse(createdAt) : 1;
  const updatedAtUnixMs = updatedAt ? Date.parse(updatedAt) : 2;
  const activeTurn =
    status === "running" || status === "working" || status === "waiting"
      ? {
          agentSessionId: canonicalOverrides.id ?? "agent-session-1",
          completedCommand: null,
          error: null,
          fileChanges: null,
          origin: "user_prompt" as const,
          outcome: null,
          phase:
            status === "waiting" ? ("waiting" as const) : ("running" as const),
          startedAtUnixMs: createdAtUnixMs,
          settledAtUnixMs: null,
          turnId: "turn-active",
          updatedAtUnixMs
        }
      : null;
  const latestTurn =
    status === "completed" || status === "failed" || status === "canceled"
      ? {
          agentSessionId: canonicalOverrides.id ?? "agent-session-1",
          completedCommand: null,
          error: null,
          fileChanges: null,
          origin: "user_prompt" as const,
          outcome: status as "completed" | "failed" | "canceled",
          phase: "settled" as const,
          settledAtUnixMs: updatedAtUnixMs,
          startedAtUnixMs: createdAtUnixMs,
          turnId: "turn-latest",
          updatedAtUnixMs
        }
      : null;
  return {
    agentTargetId: null,
    capabilities: null,
    createdAtUnixMs,
    cwd: "/",
    endedAtUnixMs: endedAt ? Date.parse(endedAt) : null,
    goal: null,
    id: "agent-session-1",
    imported: false,
    activeTurn,
    activeTurnId: activeTurn?.turnId ?? null,
    latestTurn,
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    railSectionKey: "conversations",
    resumable: true,
    settings: {},
    title: "Agent session",
    updatedAtUnixMs,
    usage: null,
    visible: true,
    ...canonicalOverrides,
    tuttiModeActivation: canonicalOverrides.tuttiModeActivation ?? null,
    kind: canonicalOverrides.kind ?? "root",
    rootAgentSessionId: canonicalOverrides.rootAgentSessionId ?? null,
    rootTurnId: canonicalOverrides.rootTurnId ?? null,
    parentAgentSessionId: canonicalOverrides.parentAgentSessionId ?? null,
    parentTurnId: canonicalOverrides.parentTurnId ?? null,
    parentToolCallId: canonicalOverrides.parentToolCallId ?? null,
    latestTurnInteractions: canonicalOverrides.latestTurnInteractions ?? [],
    pendingInteractions: canonicalOverrides.pendingInteractions ?? []
  };
}

function createSendInputResponse(session: WorkspaceAgentSession) {
  return {
    kind: "turn" as const,
    session,
    turnId: "turn-1",
    turn: {
      agentSessionId: session.id,
      completedCommand: null,
      error: null,
      fileChanges: null,
      origin: "user_prompt" as const,
      outcome: null,
      phase: "submitted" as const,
      settledAtUnixMs: null,
      startedAtUnixMs: 1,
      turnId: "turn-1",
      updatedAtUnixMs: 1
    }
  };
}

function createMessage(
  overrides: Partial<WorkspaceAgentSessionMessage> = {}
): WorkspaceAgentSessionMessage {
  return {
    agentSessionId: "agent-session-1",
    kind: "text",
    messageId: "message-1",
    occurredAtUnixMs: 1717200001000,
    payload: {},
    role: "assistant",
    sequence: 1,
    turnId: "turn-1",
    version: 1,
    ...overrides
  };
}
