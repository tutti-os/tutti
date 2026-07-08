import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { TuttidProtocolError } from "@tutti-os/client-tuttid-ts";
import { WorkspaceAgentActivityService } from "./workspaceAgentActivityService.ts";

function createService(): WorkspaceAgentActivityService {
  return new WorkspaceAgentActivityService({
    tuttidClient: {} as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });
}

test("WorkspaceAgentActivityService.sendInput keeps activity snapshot working when send response is still ready", async () => {
  const readySession = workspaceAgentSession({ status: "ready" });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [readySession],
        workspaceId: "ws-1"
      }),
      sendWorkspaceAgentSessionInput: async () => ({ session: readySession })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  await service.load("ws-1");

  const result = await service.sendInput({
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    content: [{ type: "text", text: "continue" }]
  });
  const snapshotSession = service
    .getSnapshot("ws-1")
    .sessions.find((session) => session.agentSessionId === "session-1");

  assert.equal(result.session.status, "working");
  assert.equal(result.session.currentPhase, "working");
  assert.equal(snapshotSession?.status, "working");
  assert.equal(snapshotSession?.currentPhase, "working");
});

test("WorkspaceAgentActivityService.activateSession creates target-backed sessions without provider input", async () => {
  const createCalls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      createWorkspaceAgentSession: async (
        workspaceId: string,
        request: Parameters<TuttidClient["createWorkspaceAgentSession"]>[1]
      ) => {
        createCalls.push({ request, workspaceId });
        return workspaceAgentSession({ status: "created" });
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  await service.activateSession({
    agentSessionId: "11111111-1111-4111-8111-111111111111",
    agentTargetId: "local:codex",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "hello" }],
    mode: "new",
    title: "Shared Codex",
    visible: true,
    workspaceId: "ws-1"
  });

  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], {
    workspaceId: "ws-1",
    request: {
      agentSessionId: "11111111-1111-4111-8111-111111111111",
      agentTargetId: "local:codex",
      cwd: "/workspace",
      initialContent: [{ type: "text", text: "hello" }],
      initialDisplayPrompt: null,
      model: null,
      permissionModeId: null,
      planMode: null,
      reasoningEffort: null,
      speed: null,
      title: "Shared Codex",
      visible: true
    }
  });
});

test("WorkspaceAgentActivityService keeps explicit Claude model display over default alias state", async () => {
  const createdSession = workspaceAgentSession({
    provider: "claude-code",
    settings: { model: "opus" },
    status: "working"
  });
  const loadedSession = workspaceAgentSession({
    provider: "claude-code",
    settings: { model: "default" },
    status: "working"
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      createWorkspaceAgentSession: async () => createdSession,
      getWorkspaceAgentSession: async () => loadedSession,
      sendWorkspaceAgentSessionInput: async () => ({ session: loadedSession }),
      updateWorkspaceAgentSessionVisibility: async () => loadedSession
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const activation = await service.activateSession({
    agentSessionId: "session-1",
    agentTargetId: "local:claude-code",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "hi" }],
    mode: "new",
    settings: { model: "opus" },
    title: "Claude",
    visible: true,
    workspaceId: "ws-1"
  });
  const controlState = await service.getSessionControlState({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });

  assert.equal(activation.session.status, "working");
  assert.equal(controlState.settings?.model, "opus");
});

test("WorkspaceAgentActivityService composer options cache is agent target keyed", async () => {
  const composerOptionCalls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getAgentProviderComposerOptions: async (
        provider: string,
        request: unknown
      ) => {
        composerOptionCalls.push({ provider, request });
        return {
          provider,
          modelConfig: {
            configurable: true,
            options: [{ value: `model-${composerOptionCalls.length}` }]
          },
          runtimeContext: {}
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const first = await service.getComposerOptions({
    agentTargetId: "local:codex",
    provider: "codex",
    workspaceId: "ws-1"
  });
  const second = await service.getComposerOptions({
    agentTargetId: "shared-codex",
    provider: "codex",
    workspaceId: "ws-1"
  });
  const firstCached = await service.getComposerOptions({
    agentTargetId: "local:codex",
    provider: "codex",
    workspaceId: "ws-1"
  });

  assert.equal(composerOptionCalls.length, 2);
  assert.equal(
    service.getSnapshot("ws-1").composerOptionsByAgentTargetId?.["local:codex"]
      ?.models[0]?.value,
    "model-1"
  );
  assert.equal(
    service.getSnapshot("ws-1").composerOptionsByAgentTargetId?.["shared-codex"]
      ?.models[0]?.value,
    "model-2"
  );
  assert.equal(
    service.getSnapshot("ws-1").composerOptionsByProvider?.codex,
    undefined
  );
  assert.equal(
    (first as { models?: Array<{ value: string }> }).models?.[0]?.value,
    "model-1"
  );
  assert.equal(
    (second as { models?: Array<{ value: string }> }).models?.[0]?.value,
    "model-2"
  );
  assert.equal(
    (firstCached as { models?: Array<{ value: string }> }).models?.[0]?.value,
    "model-1"
  );
});

test("WorkspaceAgentActivityService model catalog invalidation drops composer cache and notifies listeners", async () => {
  const topicHandlers = new Map<string, (event: unknown) => void>();
  let composerOptionCalls = 0;
  const service = new WorkspaceAgentActivityService({
    eventStreamClient: {
      connect: async () => {},
      dispose: () => {},
      publishIntent: async () => {},
      subscribe: (topic: string, listener: (event: unknown) => void) => {
        topicHandlers.set(topic, listener);
        return () => {};
      },
      subscribeConnectionState: () => () => {}
    } as never,
    tuttidClient: {
      getAgentProviderComposerOptions: async (provider: string) => {
        composerOptionCalls += 1;
        return {
          provider,
          modelConfig: {
            configurable: true,
            options: [{ value: `model-${composerOptionCalls}` }]
          },
          runtimeContext: {}
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  await service.getComposerOptions({ provider: "codex", workspaceId: "ws-1" });
  await service.getComposerOptions({ provider: "codex", workspaceId: "ws-1" });
  assert.equal(composerOptionCalls, 1);

  const invalidationHandler = topicHandlers.get(
    "agent.model.catalog.invalidated"
  );
  assert.ok(
    invalidationHandler,
    "service must subscribe to the model catalog invalidation topic"
  );
  const received: unknown[] = [];
  service.onModelCatalogInvalidated((event) => {
    received.push(event);
  });
  invalidationHandler({
    payload: { providers: ["codex"], occurredAtUnixMs: 1000 }
  });

  assert.deepEqual(received, [
    { providers: ["codex"], occurredAtUnixMs: 1000 }
  ]);
  await service.getComposerOptions({ provider: "codex", workspaceId: "ws-1" });
  assert.equal(composerOptionCalls, 2);
});

test("WorkspaceAgentActivityService.importExternalSessions refreshes sessions and projects", async () => {
  const importCalls: unknown[] = [];
  let listCalls = 0;
  let projectRefreshCalls = 0;
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      importWorkspaceExternalAgentSessions: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["importWorkspaceExternalAgentSessions"]
        >[1]
      ) => {
        importCalls.push({ workspaceId, request });
        return {
          errors: [],
          importedMessages: 2,
          importedProjects: 1,
          importedSessions: 1,
          skippedSessions: 0
        };
      },
      listWorkspaceAgentSessions: async () => {
        listCalls += 1;
        return { hasMore: false, sessions: [], workspaceId: "ws-1" };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    },
    workspaceUserProjectService: {
      refresh: async () => {
        projectRefreshCalls += 1;
      }
    } as never
  });

  const result = await service.importExternalSessions("ws-1", {
    projects: [{ path: "/repo" }]
  });

  assert.deepEqual(importCalls, [
    { workspaceId: "ws-1", request: { projects: [{ path: "/repo" }] } }
  ]);
  assert.equal(result.importedMessages, 2);
  assert.equal(listCalls, 1);
  assert.equal(projectRefreshCalls, 1);
});

test("WorkspaceAgentActivityService fetches combined reconcile state after messages", async () => {
  const diagnostics: unknown[] = [];
  const calls: string[] = [];
  let messagesResolved = false;
  const staleSession = workspaceAgentSession({
    status: "running",
    updatedAt: "2026-07-06T03:48:10.600Z",
    turnLifecycle: {
      activeTurnId: "turn-1",
      phase: "running"
    },
    submitAvailability: { state: "blocked", reason: "active_turn" }
  });
  const finalSession = workspaceAgentSession({
    status: "ready",
    updatedAt: "2026-07-06T03:48:30.878Z",
    currentPhase: "idle",
    turnLifecycle: {
      activeTurnId: null,
      outcome: "completed",
      phase: "settled"
    },
    submitAvailability: { state: "available" }
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async () => {
        calls.push("getSession");
        return messagesResolved ? finalSession : staleSession;
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [staleSession],
        workspaceId: "ws-1"
      }),
      listWorkspaceAgentSessionMessages: async () => {
        calls.push("listMessages");
        messagesResolved = true;
        return {
          hasMore: false,
          latestVersion: 2,
          messages: []
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async (payload) => {
        diagnostics.push(payload);
      }
    }
  });

  await service.load("ws-1");
  await (
    service as unknown as {
      reconcileAgentActivityUpdate(input: {
        agentSessionId: string;
        eventType: string;
        workspaceId: string;
      }): Promise<void>;
    }
  ).reconcileAgentActivityUpdate({
    agentSessionId: "session-1",
    eventType: "message_update",
    workspaceId: "ws-1"
  });

  const session = service.getSnapshot("ws-1").sessions[0];
  assert.deepEqual(calls, ["listMessages", "getSession"]);
  assert.equal(session?.status, "ready");
  assert.equal(session?.turnLifecycle?.phase, "settled");
  assert.equal(session?.submitAvailability?.state, "available");
  assert.deepEqual(
    diagnostics
      .filter(
        (entry): entry is { details: { traceEvent?: string }; event: string } =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { event?: unknown }).event ===
            "agent.activity.reconcile.trace"
      )
      .map((entry) => entry.details.traceEvent)
      .filter(
        (traceEvent) =>
          typeof traceEvent === "string" &&
          traceEvent.startsWith("reconcile.combined")
      ),
    [
      "reconcile.combined.messages_requested",
      "reconcile.combined.messages_resolved",
      "reconcile.combined.state_fetch.requested",
      "reconcile.combined.state_fetch.resolved",
      "reconcile.combined.state_upsert",
      "reconcile.combined.state_upsert.applied"
    ]
  );
});

test("WorkspaceAgentActivityService.listAgentGeneratedFiles delegates to tuttid workspace aggregate", async () => {
  const calls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentGeneratedFiles: async (
        workspaceId: string,
        request: Parameters<TuttidClient["listWorkspaceAgentGeneratedFiles"]>[1]
      ) => {
        calls.push({ request, workspaceId });
        return {
          entries: [{ label: "report.md", path: "/workspace/report.md" }],
          workspaceId
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const result = await service.listAgentGeneratedFiles({
    limit: 20,
    query: "report",
    sessionCwd: "/workspace",
    workspaceId: " ws-1 "
  });

  assert.deepEqual(calls, [
    {
      request: {
        limit: 20,
        query: "report",
        sessionCwd: "/workspace"
      },
      workspaceId: "ws-1"
    }
  ]);
  assert.deepEqual(result.entries, [
    { label: "report.md", path: "/workspace/report.md" }
  ]);
});

test("WorkspaceAgentActivityService.listSessionSectionPage forwards abort signal to tuttid", async () => {
  const abortController = new AbortController();
  const listCalls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessionSectionPage: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["listWorkspaceAgentSessionSectionPage"]
        >[1],
        options: Parameters<
          TuttidClient["listWorkspaceAgentSessionSectionPage"]
        >[2]
      ) => {
        listCalls.push({ options, request, workspaceId });
        return {
          section: {
            hasMore: false,
            kind: "project",
            sectionKey: "project:/workspace",
            sessions: []
          },
          workspaceId
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  await service.listSessionSectionPage({
    workspaceId: "ws-1",
    agentTargetId: "claude-target",
    cursor: "10|session-1",
    limit: 5,
    sectionKey: "project:/workspace",
    signal: abortController.signal
  });

  assert.deepEqual(listCalls, [
    {
      workspaceId: "ws-1",
      request: {
        agentTargetId: "claude-target",
        cursor: "10|session-1",
        limit: 5,
        sectionKey: "project:/workspace"
      },
      options: { signal: abortController.signal }
    }
  ]);
});

test("WorkspaceAgentActivityService.listSessionSections forwards agent target filter to tuttid", async () => {
  const abortController = new AbortController();
  const listCalls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessionSections: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["listWorkspaceAgentSessionSections"]
        >[1],
        options: Parameters<
          TuttidClient["listWorkspaceAgentSessionSections"]
        >[2]
      ) => {
        listCalls.push({ options, request, workspaceId });
        return {
          sections: [],
          workspaceId
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  await service.listSessionSections({
    workspaceId: "ws-1",
    agentTargetId: "claude-target",
    limitPerSection: 5,
    signal: abortController.signal
  });

  assert.deepEqual(listCalls, [
    {
      workspaceId: "ws-1",
      request: {
        agentTargetId: "claude-target",
        limitPerSection: 5
      },
      options: { signal: abortController.signal }
    }
  ]);
});

test("WorkspaceAgentActivityService treats missing reconcile sessions as tombstones", async () => {
  const diagnostics: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async () => {
        throw new TuttidProtocolError({
          code: "workspace_not_found",
          developerMessage: "workspace agent session not found",
          reason: "workspace_agent_session_not_found",
          statusCode: 404
        });
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async (payload) => {
        diagnostics.push(payload);
      }
    }
  });

  await (
    service as unknown as {
      reconcileAgentActivityUpdate(input: {
        agentSessionId: string;
        eventType: string;
        workspaceId: string;
      }): Promise<void>;
    }
  ).reconcileAgentActivityUpdate({
    agentSessionId: "ghost-session",
    eventType: "session_update",
    workspaceId: "ws-1"
  });

  assert.deepEqual(diagnostics.at(-1), {
    details: {
      agentSessionId: "ghost-session",
      error: "workspace agent session not found"
    },
    event: "agent.activity.reconcile_session_missing",
    level: "info",
    workspaceId: "ws-1"
  });
});

test("WorkspaceAgentActivityService.submitPlanDecision runs planMode-off then sendInput for a codex implement decision", async () => {
  const service = createService();

  const updateSettingsCalls: unknown[] = [];
  const sendInputCalls: unknown[] = [];
  const submitInteractiveCalls: unknown[] = [];

  service.updateSessionSettings = async (input) => {
    updateSettingsCalls.push(input);
    return { agentSessionId: input.agentSessionId, settings: {} };
  };
  service.sendInput = async (input) => {
    sendInputCalls.push(input);
    return {} as never;
  };
  service.submitInteractive = async (input) => {
    submitInteractiveCalls.push(input);
    return undefined;
  };

  await service.submitPlanDecision({
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    promptKind: "plan-implementation",
    action: "implement",
    requestId: "turn-1"
  });

  assert.equal(updateSettingsCalls.length, 1);
  assert.deepEqual(updateSettingsCalls[0], {
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    settings: { planMode: false }
  });

  assert.equal(sendInputCalls.length, 1);
  assert.deepEqual(sendInputCalls[0], {
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    content: [{ type: "text", text: "Implement the plan." }]
  });

  assert.equal(submitInteractiveCalls.length, 0);
});

test("WorkspaceAgentActivityService.submitPlanDecision routes a claude exit-plan decision through submitInteractive", async () => {
  const service = createService();

  const submitInteractiveCalls: unknown[] = [];

  service.updateSessionSettings = async () => {
    throw new Error("updateSessionSettings should not be called");
  };
  service.sendInput = async () => {
    throw new Error("sendInput should not be called");
  };
  service.submitInteractive = async (input) => {
    submitInteractiveCalls.push(input);
    return undefined;
  };

  await service.submitPlanDecision({
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    promptKind: "exit-plan",
    action: "allow",
    optionId: "acceptEdits",
    requestId: "req-1"
  });

  assert.equal(submitInteractiveCalls.length, 1);
  assert.deepEqual(submitInteractiveCalls[0], {
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    requestId: "req-1",
    action: "allow",
    optionId: "acceptEdits"
  });
});

function workspaceAgentSession(overrides: {
  currentPhase?: string;
  provider?: string;
  runtimeContext?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  status: string;
  submitAvailability?: Record<string, unknown>;
  turnLifecycle?: Record<string, unknown>;
  updatedAt?: string;
}): Record<string, unknown> {
  return {
    id: "session-1",
    provider: overrides.provider ?? "codex",
    cwd: "/workspace",
    title: "Session 1",
    status: overrides.status,
    ...(overrides.runtimeContext
      ? { runtimeContext: overrides.runtimeContext }
      : {}),
    ...(overrides.settings ? { settings: overrides.settings } : {}),
    ...(overrides.currentPhase ? { currentPhase: overrides.currentPhase } : {}),
    ...(overrides.submitAvailability
      ? { submitAvailability: overrides.submitAvailability }
      : {}),
    ...(overrides.turnLifecycle
      ? { turnLifecycle: overrides.turnLifecycle }
      : {}),
    visible: true,
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-16T00:00:00.000Z"
  };
}
