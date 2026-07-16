import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { TuttidProtocolError } from "@tutti-os/client-tuttid-ts";
import {
  selectEngineTurnsForSession,
  selectSessionActivationPresentations,
  selectSessionAttention
} from "@tutti-os/agent-activity-core";
import { WorkspaceAgentActivityService } from "./workspaceAgentActivityService.ts";

test("WorkspaceAgentActivityService starts one canonical workspace load when the shared engine is created", async () => {
  let listCalls = 0;
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => {
        listCalls += 1;
        return { hasMore: false, sessions: [], workspaceId: "ws-1" };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const first = service.getSessionEngine("ws-1");
  const second = service.getSessionEngine("ws-1");
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(listCalls, 1);
  assert.equal(
    first.getSnapshot().engineRuntime.workspaceReconcile.status,
    "ready"
  );
});

test("WorkspaceAgentActivityService coalesces concurrent workspace loads", async () => {
  let listCalls = 0;
  let resolveList!: (value: {
    hasMore: false;
    sessions: [];
    workspaceId: string;
  }) => void;
  const listResult = new Promise<{
    hasMore: false;
    sessions: [];
    workspaceId: string;
  }>((resolve) => {
    resolveList = resolve;
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => {
        listCalls += 1;
        return listResult;
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const first = service.load("ws-1");
  const second = service.load("ws-1");
  assert.equal(first, second);
  assert.equal(listCalls, 1);

  resolveList({ hasMore: false, sessions: [], workspaceId: "ws-1" });
  await Promise.all([first, second]);
  assert.equal(listCalls, 1);
});

test("WorkspaceAgentActivityService.sendInput preserves the authoritative ready response", async () => {
  const readySession = workspaceAgentSession({ status: "ready" });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [readySession],
        workspaceId: "ws-1"
      }),
      sendWorkspaceAgentSessionInput: async () => ({
        kind: "turn",
        session: readySession,
        turnId: "turn-1",
        turn: workspaceAgentTurn({ phase: "submitted" })
      })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  await service.load("ws-1");

  const result = await service.sendInput({
    clientSubmitId: "submit-1",
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    content: [{ type: "text", text: "continue" }]
  });
  const snapshotSession = service
    .getSnapshot("ws-1")
    .sessions.find((session) => session.agentSessionId === "session-1");

  assert.equal(result.session.activeTurn, null);
  assert.notEqual(result.kind, "goalControl");
  if (result.kind === "goalControl") {
    throw new Error("expected a Turn-producing send result");
  }
  assert.equal(result.turn.phase, "submitted");
  assert.equal(snapshotSession?.activeTurn, null);
});

test("WorkspaceAgentActivityService.cancelTurn delegates the exact turn", async () => {
  const calls: string[][] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      cancelWorkspaceAgentTurn: async (...args: string[]) => {
        calls.push(args);
        return { cancel: { canceled: true, reason: "turn_canceled" } };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const result = await service.cancelTurn({
    agentSessionId: "session-1",
    turnId: "turn-1",
    workspaceId: " ws-1 "
  });

  assert.deepEqual(calls, [["ws-1", "session-1", "turn-1"]]);
  assert.deepEqual(result, {
    cancel: { canceled: true, reason: "turn_canceled" }
  });
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
    clientSubmitId: "submit-activate-codex",
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
      clientSubmitId: "submit-activate-codex",
      cwd: "/workspace",
      initialContent: [{ type: "text", text: "hello" }],
      initialDisplayPrompt: null,
      model: null,
      noProject: null,
      permissionModeId: null,
      planMode: null,
      reasoningEffort: null,
      speed: null,
      title: "Shared Codex",
      visible: true
    }
  });
});

test("WorkspaceAgentActivityService confirms engine activation from the realtime session upsert", async () => {
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      createWorkspaceAgentSession: async () => ({
        ...workspaceAgentSession({ status: "completed" }),
        createdAtUnixMs: Date.now()
      }),
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  const engine = service.getSessionEngine("ws-1");
  const requestedAtUnixMs = Date.now();
  engine.dispatch({
    type: "activation/requested",
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: requestedAtUnixMs + 45_000,
    mode: "new",
    requestedAtUnixMs,
    requestId: "activation-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    selectSessionActivationPresentations(engine.getSnapshot())["session-1"]
      ?.status,
    "active"
  );
  engine.dispatch({
    type: "engine/intentExpired",
    expiryId: "activation:activation-1",
    dueAtUnixMs: requestedAtUnixMs + 45_000
  });
  assert.equal(
    selectSessionActivationPresentations(engine.getSnapshot())["session-1"]
      ?.status,
    "active"
  );
});

test("WorkspaceAgentActivityService reads existing session settings from the daemon", async () => {
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
      getWorkspaceAgentSession: async () => ({
        session: loadedSession,
        childSessions: [],
        turns: []
      }),
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
    clientSubmitId: "submit-activate-claude",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "hi" }],
    mode: "new",
    settings: { model: "opus" },
    title: "Claude",
    visible: true,
    workspaceId: "ws-1"
  });
  const canonicalSession = await service.getSession("ws-1", "session-1");

  assert.equal(activation.session.provider, "claude-code");
  assert.equal(canonicalSession.settings?.model, "default");
});

test("WorkspaceAgentActivityService returns the authoritative canonical session after settings update", async () => {
  const updatedSession = workspaceAgentSession({
    provider: "claude-code",
    settings: { model: "opus", planMode: true },
    status: "waiting"
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      updateWorkspaceAgentSessionSettings: async () => updatedSession
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const result = await service.updateSessionSettings({
    agentSessionId: "session-1",
    settings: { model: "opus", planMode: true },
    workspaceId: "ws-1"
  });

  assert.equal(result.agentSessionId, "session-1");
  assert.deepEqual(result.settings, {
    model: "opus",
    permissionModeId: null,
    planMode: true,
    reasoningEffort: null,
    speed: null
  });
  assert.equal(result.session.workspaceId, "ws-1");
  assert.equal(result.session.agentSessionId, "session-1");
  assert.equal(result.session.provider, "claude-code");
  assert.deepEqual(result.session.settings, {
    model: "opus",
    planMode: true
  });
});

test("WorkspaceAgentActivityService returns the authoritative canonical session after interactive submit", async () => {
  const submittedSession = workspaceAgentSession({
    provider: "codex",
    status: "working"
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      submitWorkspaceAgentInteractive: async () => submittedSession
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const result = await service.submitInteractive({
    agentSessionId: "session-1",
    action: "submit",
    requestId: "request-1",
    turnId: "turn-active",
    workspaceId: "ws-1"
  });

  assert.equal(result.session.workspaceId, "ws-1");
  assert.equal(result.session.agentSessionId, "session-1");
  assert.equal(result.session.activeTurn?.phase, "running");
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
    service.getSnapshot("ws-1").composerOptionsByTargetKey?.["local:codex"]
      ?.models[0]?.value,
    "model-1"
  );
  assert.equal(
    service.getSnapshot("ws-1").composerOptionsByTargetKey?.["shared-codex"]
      ?.models[0]?.value,
    "model-2"
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

  await service.getComposerOptions({
    agentTargetId: "local:codex",
    provider: "codex",
    workspaceId: "ws-1"
  });
  await service.getComposerOptions({
    agentTargetId: "local:codex",
    provider: "codex",
    workspaceId: "ws-1"
  });
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
  await service.getComposerOptions({
    agentTargetId: "local:codex",
    provider: "codex",
    workspaceId: "ws-1"
  });
  assert.equal(composerOptionCalls, 2);
});

test("WorkspaceAgentActivityService starts session-event streams and preserves uncached outcome patches", async () => {
  const subscriptions: Array<{
    scope: unknown;
    topic: string;
  }> = [];
  const listenersByTopic = new Map<string, (event: unknown) => void>();
  let connectCalls = 0;
  const service = new WorkspaceAgentActivityService({
    eventStreamClient: {
      connect: async () => {
        connectCalls += 1;
      },
      dispose: () => {},
      publishIntent: async () => {},
      subscribe: (
        topic: string,
        listener: (event: unknown) => void,
        options?: unknown
      ) => {
        listenersByTopic.set(topic, listener);
        subscriptions.push({
          scope:
            options && typeof options === "object" && "scope" in options
              ? options.scope
              : null,
          topic
        });
        return () => {};
      },
      subscribeConnectionState: () => () => {}
    } as never,
    tuttidClient: {
      getWorkspaceAgentSession: async () => ({
        session: workspaceAgentSession({
          currentPhase: "idle",
          status: "completed",
          turnLifecycle: {
            activeTurnId: null,
            outcome: "completed",
            phase: "settled"
          }
        }),
        childSessions: [],
        turns: []
      })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const receivedEvent = new Promise<unknown>((resolve) => {
    service.onSessionEvent(" ws-1 ", resolve);
  });

  assert.deepEqual(subscriptions, [
    {
      scope: { workspaceId: "ws-1" },
      topic: "agent.activity.updated"
    },
    {
      scope: null,
      topic: "agent.model.catalog.invalidated"
    }
  ]);
  assert.equal(connectCalls, 1);
  const activityUpdatedListener = listenersByTopic.get(
    "agent.activity.updated"
  );
  assert.ok(activityUpdatedListener);

  const sourceEvent = {
    data: {
      agentSessionId: "session-1",
      provider: "codex",
      title: "Finish the task",
      turn: {
        outcome: "completed",
        phase: "settled",
        turnId: "turn-1"
      },
      workspaceId: "ws-1"
    },
    eventType: "state_patch"
  };
  activityUpdatedListener({
    payload: {
      agentSessionId: "session-1",
      data: sourceEvent.data,
      eventType: sourceEvent.eventType,
      workspaceId: "ws-1"
    }
  });

  assert.deepEqual(await receivedEvent, sourceEvent);

  const receivedTurnEvent = new Promise<unknown>((resolve) => {
    service.onSessionEvent("ws-1", resolve);
  });
  const turnEvent = {
    data: {
      activeTurnId: null,
      agentSessionId: "session-1",
      eventType: "turn_update",
      occurredAtUnixMs: 2,
      turn: workspaceAgentTurn({ outcome: "completed", phase: "settled" }),
      workspaceId: "ws-1"
    },
    eventType: "turn_update"
  };
  activityUpdatedListener({
    payload: {
      agentSessionId: "session-1",
      data: turnEvent.data,
      eventType: turnEvent.eventType,
      workspaceId: "ws-1"
    }
  });

  assert.deepEqual(await receivedTurnEvent, turnEvent);
});

test("WorkspaceAgentActivityService dispose releases every event stream subscription", () => {
  const activeSubscriptions = new Set<symbol>();
  const subscribe = () => {
    const id = Symbol("subscription");
    activeSubscriptions.add(id);
    return () => activeSubscriptions.delete(id);
  };
  const service = new WorkspaceAgentActivityService({
    eventStreamClient: {
      connect: async () => {},
      dispose: () => {},
      publishIntent: async () => {},
      subscribe: () => subscribe(),
      subscribeConnectionState: () => subscribe()
    } as never,
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  service.onSessionEvent("ws-1", () => {});
  assert.equal(activeSubscriptions.size, 3);

  service.dispose();
  service.dispose();
  assert.equal(activeSubscriptions.size, 0);
});

test("WorkspaceAgentActivityService preserves realtime turn provenance for attention", async () => {
  const listenersByTopic = new Map<string, (event: unknown) => void>();
  const running = workspaceAgentSession({
    status: "working",
    updatedAt: "2026-07-14T00:00:01.000Z"
  });
  const settled = workspaceAgentSession({
    status: "completed",
    updatedAt: "2026-07-14T00:00:02.000Z"
  });
  const service = new WorkspaceAgentActivityService({
    eventStreamClient: {
      connect: async () => {},
      dispose: () => {},
      publishIntent: async () => {},
      subscribe: (topic: string, listener: (event: unknown) => void) => {
        listenersByTopic.set(topic, listener);
        return () => {};
      },
      subscribeConnectionState: () => () => {}
    } as never,
    tuttidClient: {
      getWorkspaceAgentSession: async () => ({
        session: settled,
        childSessions: [],
        turns: []
      }),
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [running],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  await service.load("ws-1");
  const activityUpdated = listenersByTopic.get("agent.activity.updated");
  assert.ok(activityUpdated);
  activityUpdated({
    payload: {
      agentSessionId: "session-1",
      data: {
        activeTurnId: null,
        agentSessionId: "session-1",
        eventType: "turn_update",
        occurredAtUnixMs: 2,
        turn: workspaceAgentTurn({ outcome: "completed", phase: "settled" }),
        workspaceId: "ws-1"
      },
      eventType: "turn_update",
      workspaceId: "ws-1"
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    selectSessionAttention(
      service.getSessionEngine("ws-1").getSnapshot(),
      "local",
      "session-1"
    )?.isUnread,
    true
  );

  const historical = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [settled],
        workspaceId: "ws-2"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  await historical.load("ws-2");
  assert.equal(
    selectSessionAttention(
      historical.getSessionEngine("ws-2").getSnapshot(),
      "local",
      "session-1"
    )?.isUnread,
    false
  );
});

test("WorkspaceAgentActivityService preserves live provenance across a transient reconcile failure", async () => {
  const listenersByTopic = new Map<string, (event: unknown) => void>();
  let getCalls = 0;
  const running = workspaceAgentSession({
    status: "working",
    updatedAt: "2026-07-14T00:00:01.000Z"
  });
  const settled = workspaceAgentSession({
    status: "completed",
    updatedAt: "2026-07-14T00:00:02.000Z"
  });
  const service = new WorkspaceAgentActivityService({
    eventStreamClient: {
      connect: async () => {},
      dispose: () => {},
      publishIntent: async () => {},
      subscribe: (topic: string, listener: (event: unknown) => void) => {
        listenersByTopic.set(topic, listener);
        return () => {};
      },
      subscribeConnectionState: () => () => {}
    } as never,
    tuttidClient: {
      getWorkspaceAgentSession: async () => {
        getCalls += 1;
        if (getCalls === 2) throw new Error("temporary reconcile failure");
        return {
          session: getCalls === 1 ? running : settled,
          childSessions: [],
          turns: []
        };
      },
      listWorkspaceAgentSessionMessages: async () => ({
        hasMore: false,
        latestVersion: 0,
        messages: []
      }),
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [running],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  await service.load("ws-1");
  const activityUpdated = listenersByTopic.get("agent.activity.updated");
  assert.ok(activityUpdated);
  activityUpdated({
    payload: {
      agentSessionId: "session-1",
      data: {
        agentSessionId: "session-1",
        eventType: "turn_update",
        occurredAtUnixMs: 2,
        workspaceId: "ws-1"
      },
      eventType: "turn_update",
      workspaceId: "ws-1"
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  service.ensureSessionSynchronized({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // Initial active-root hydration + failed live pull + combined detail/message
  // synchronization (detail before and after messages).
  assert.equal(getCalls, 4);
  assert.equal(
    selectSessionAttention(
      service.getSessionEngine("ws-1").getSnapshot(),
      "local",
      "session-1"
    )?.isUnread,
    true
  );
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
    archivePath: "/tmp/claude-export.zip",
    projects: [{ path: "/repo" }]
  });

  assert.deepEqual(importCalls, [
    {
      workspaceId: "ws-1",
      request: {
        archivePath: "/tmp/claude-export.zip",
        projects: [{ path: "/repo" }]
      }
    }
  ]);
  assert.equal(result.importedMessages, 2);
  assert.equal(listCalls, 1);
  assert.equal(projectRefreshCalls, 1);
});

test("WorkspaceAgentActivityService selects, scans, and imports the same Claude export archive", async () => {
  const scanCalls: unknown[] = [];
  const importCalls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    hostFilesApi: {
      async createUserDocumentsProjectDirectory() {
        return { path: "/tmp/project" };
      },
      async selectAppArchive() {
        return "/tmp/claude-export.zip";
      }
    } as never,
    tuttidClient: {
      scanWorkspaceExternalAgentSessionImports: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["scanWorkspaceExternalAgentSessionImports"]
        >[1]
      ) => {
        scanCalls.push({ workspaceId, request });
        return {
          errors: [],
          projects: [],
          providers: [],
          scannedMessages: 0,
          scannedSessions: 0,
          sessions: [],
          skippedSessions: 0
        };
      },
      importWorkspaceExternalAgentSessions: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["importWorkspaceExternalAgentSessions"]
        >[1]
      ) => {
        importCalls.push({ workspaceId, request });
        return {
          errors: [],
          importedMessages: 0,
          importedProjects: 0,
          importedSessions: 0,
          skippedSessions: 0
        };
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const archivePath = await service.selectExternalSessionImportArchive();
  assert.equal(archivePath, "/tmp/claude-export.zip");
  assert.ok(archivePath);
  await service.scanExternalSessionImports("ws-1", {
    archivePath,
    days: -1
  });
  await service.importExternalSessions("ws-1", {
    archivePath,
    projects: [{ path: "/Users/demo", sessionIds: ["session-1"] }]
  });
  assert.deepEqual(scanCalls, [
    {
      workspaceId: "ws-1",
      request: { archivePath: "/tmp/claude-export.zip", days: -1 }
    }
  ]);
  assert.deepEqual(importCalls, [
    {
      workspaceId: "ws-1",
      request: {
        archivePath: "/tmp/claude-export.zip",
        projects: [{ path: "/Users/demo", sessionIds: ["session-1"] }]
      }
    }
  ]);
});

test("WorkspaceAgentActivityService fetches detail before combined message reconciliation", async () => {
  const diagnostics: unknown[] = [];
  const calls: string[] = [];
  let messagesResolved = false;
  const staleSession = workspaceAgentSession({
    status: "running",
    updatedAt: "2026-07-06T03:48:10.600Z",
    activeTurnId: "turn-1",
    activeTurn: workspaceAgentTurn({ phase: "running" })
  });
  const finalSession = workspaceAgentSession({
    status: "ready",
    updatedAt: "2026-07-06T03:48:30.878Z",
    activeTurnId: null,
    activeTurn: null,
    latestTurn: workspaceAgentTurn({
      outcome: "completed",
      phase: "settled"
    })
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async () => {
        calls.push("getSession");
        return {
          session: messagesResolved ? finalSession : staleSession,
          childSessions: [],
          turns: []
        };
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
  service.ensureSessionSynchronized({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const session = service.getSnapshot("ws-1").sessions[0];
  assert.deepEqual(calls, [
    "getSession", // initial active-root child hydration
    "getSession",
    "listMessages",
    "getSession"
  ]);
  assert.equal(session?.activeTurn, null);
  assert.equal(session?.latestTurn?.phase, "settled");
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
      "reconcile.combined.discovery_fetch.requested",
      "reconcile.combined.discovery_fetch.resolved",
      "reconcile.combined.messages_requested",
      "reconcile.combined.messages_resolved",
      "reconcile.combined.state_fetch.requested",
      "reconcile.combined.state_fetch.resolved",
      "reconcile.combined.state_upsert",
      "reconcile.combined.state_upsert.applied"
    ]
  );
});

test("WorkspaceAgentActivityService reconciles child sessions and their messages through root detail", async () => {
  const root = {
    ...workspaceAgentSession({ status: "working" }),
    kind: "root"
  };
  const child = {
    ...workspaceAgentSession({ status: "working" }),
    id: "child-1",
    kind: "child",
    rootAgentSessionId: "session-1",
    rootTurnId: "turn-1",
    parentAgentSessionId: "session-1",
    parentTurnId: "turn-1",
    parentToolCallId: "spawn-1",
    title: "Child 1"
  };
  const messageRequests: string[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async () => ({
        session: root,
        childSessions: [child],
        turns: [
          {
            agentSessionId: "session-1",
            turnId: "turn-1",
            phase: "settled",
            outcome: "completed",
            error: null,
            completedCommand: null,
            startedAtUnixMs: 1,
            settledAtUnixMs: 2,
            updatedAtUnixMs: 2,
            fileChanges: {
              files: [{ path: "/workspace/removed.txt", change: "deleted" }]
            }
          }
        ]
      }),
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [root],
        workspaceId: "ws-1"
      }),
      listWorkspaceAgentSessionMessages: async (
        _workspaceId: string,
        agentSessionId: string
      ) => {
        messageRequests.push(agentSessionId);
        return {
          hasMore: false,
          latestVersion: 1,
          messages: [
            {
              agentSessionId,
              kind: "text",
              messageId: `${agentSessionId}-message-1`,
              occurredAtUnixMs: 1,
              payload: { text: agentSessionId },
              role: "assistant",
              turnId: agentSessionId === "child-1" ? "child-turn-1" : "turn-1",
              version: 1
            }
          ]
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  await service.load("ws-1");
  assert.deepEqual(
    service
      .getSnapshot("ws-1")
      .sessions.map((session) => session.agentSessionId)
      .sort(),
    ["child-1", "session-1"]
  );
  assert.deepEqual(messageRequests, []);

  service.ensureSessionSynchronized({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = service.getSnapshot("ws-1");
  assert.deepEqual(messageRequests.sort(), ["child-1", "session-1"]);
  assert.deepEqual(
    snapshot.sessions.map((session) => session.agentSessionId).sort(),
    ["child-1", "session-1"]
  );
  assert.equal(
    snapshot.sessions.find((session) => session.agentSessionId === "child-1")
      ?.kind,
    "child"
  );
  assert.equal(
    snapshot.sessionMessagesById["child-1"]?.[0]?.turnId,
    "child-turn-1"
  );
  assert.deepEqual(
    selectEngineTurnsForSession(
      service.getSessionEngine("ws-1").getSnapshot(),
      "session-1"
    ).map((turn) => ({
      turnId: turn.turnId,
      phase: turn.phase,
      updatedAtUnixMs: turn.updatedAtUnixMs,
      fileChanges: turn.fileChanges
    })),
    [
      {
        turnId: "turn-1",
        phase: "settled",
        updatedAtUnixMs: 2,
        fileChanges: {
          files: [{ path: "/workspace/removed.txt", change: "deleted" }]
        }
      }
    ]
  );
});

test("WorkspaceAgentActivityService loads the newest history page first", async () => {
  const requests: unknown[] = [];
  const session = workspaceAgentSession({ status: "ready" });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async () => ({
        session,
        childSessions: [],
        turns: []
      }),
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [session],
        workspaceId: "ws-1"
      }),
      listWorkspaceAgentSessionMessages: async (
        _workspaceId: string,
        _agentSessionId: string,
        request: unknown
      ) => {
        requests.push(request);
        return { hasMore: true, latestVersion: 200, messages: [] };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  await service.load("ws-1");
  service.ensureSessionSynchronized({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests, [
    { afterVersion: 0, beforeVersion: undefined, limit: 100, order: "desc" }
  ]);
});

test("WorkspaceAgentActivityService drains every incremental history page", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const session = workspaceAgentSession({ status: "ready" });
  let mode: "idle" | "incremental" | "seed" = "idle";
  const message = (version: number) => ({
    agentSessionId: "session-1",
    kind: "text",
    messageId: `message-${version}`,
    occurredAtUnixMs: version,
    payload: { text: String(version) },
    role: "user",
    turnId: `turn-${version}`,
    version
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async () => ({
        session,
        childSessions: [],
        turns: []
      }),
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [session],
        workspaceId: "ws-1"
      }),
      listWorkspaceAgentSessionMessages: async (
        _workspaceId: string,
        _agentSessionId: string,
        request: Record<string, unknown>
      ) => {
        requests.push(request);
        if (mode === "seed") {
          return {
            hasMore: false,
            latestVersion: 100,
            messages: [message(100)]
          };
        }
        if (mode === "incremental" && request.afterVersion === 100) {
          return {
            hasMore: true,
            latestVersion: 200,
            messages: [message(200)]
          };
        }
        if (mode === "incremental" && request.afterVersion === 200) {
          return {
            hasMore: false,
            latestVersion: 300,
            messages: [message(300)]
          };
        }
        return { hasMore: false, latestVersion: 0, messages: [] };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  await service.load("ws-1");
  await new Promise((resolve) => setImmediate(resolve));
  mode = "seed";
  await service.listSessionMessages({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });
  assert.deepEqual(
    service
      .getSnapshot("ws-1")
      .sessionMessagesById["session-1"]?.map((item) => item.version),
    [100]
  );
  mode = "incremental";
  requests.length = 0;
  await (
    service as unknown as {
      reconcileAgentSessionMessages(
        workspaceId: string,
        agentSessionId: string
      ): Promise<unknown>;
    }
  ).reconcileAgentSessionMessages("ws-1", "session-1");

  assert.deepEqual(
    requests.map((request) => request.afterVersion),
    [100, 200]
  );
  assert.deepEqual(
    service
      .getSnapshot("ws-1")
      .sessionMessagesById["session-1"]?.map((item) => item.version),
    [100, 200, 300]
  );
});

test("WorkspaceAgentActivityService.listAgentGeneratedFiles delegates to tuttid workspace aggregate", async () => {
  const calls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentGeneratedFiles: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["listWorkspaceAgentGeneratedFiles"]
        >[1],
        requestOptions: Parameters<
          TuttidClient["listWorkspaceAgentGeneratedFiles"]
        >[2]
      ) => {
        calls.push({ request, requestOptions, workspaceId });
        return {
          entries: [{ label: "report.md", path: "/workspace/report.md" }],
          hasMore: true,
          nextCursor: "v1:20",
          workspaceId
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const result = await service.listAgentGeneratedFiles({
    agentTargetIds: [" local:codex ", "local:claude-code"],
    cursor: " v1:10 ",
    limit: 20,
    query: "report",
    sectionKey: "project:/workspace",
    workspaceId: " ws-1 "
  });

  assert.deepEqual(calls, [
    {
      request: {
        agentTargetIds: ["local:codex", "local:claude-code"],
        cursor: "v1:10",
        limit: 20,
        query: "report",
        sectionKey: "project:/workspace"
      },
      requestOptions: { signal: undefined },
      workspaceId: "ws-1"
    }
  ]);
  assert.deepEqual(result.entries, [
    { label: "report.md", path: "/workspace/report.md" }
  ]);
});

test("WorkspaceAgentActivityService.listAgentGeneratedFiles fails closed for an empty target constraint", async () => {
  let requestCount = 0;
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentGeneratedFiles: async () => {
        requestCount += 1;
        return { entries: [], hasMore: false, workspaceId: "ws-1" };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const result = await service.listAgentGeneratedFiles({
    agentTargetIds: [" ", ""],
    sectionKey: "project:/workspace",
    workspaceId: " ws-1 "
  });

  assert.equal(requestCount, 0);
  assert.deepEqual(result, {
    entries: [],
    hasMore: false,
    workspaceId: "ws-1"
  });
});

test("WorkspaceAgentActivityService.listSessionsPage forwards backend search pagination", async () => {
  const abortController = new AbortController();
  const listCalls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async (
        workspaceId: string,
        request: Parameters<TuttidClient["listWorkspaceAgentSessions"]>[1],
        options: Parameters<TuttidClient["listWorkspaceAgentSessions"]>[2]
      ) => {
        listCalls.push({ options, request, workspaceId });
        return {
          hasMore: true,
          nextCursor: "10|session-1",
          sessions: [workspaceAgentSession({ status: "completed" })],
          workspaceId
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const result = await service.listSessionsPage({
    agentTargetId: " target-1 ",
    cursor: " 20|session-2 ",
    limit: 100,
    searchQuery: " backend result ",
    signal: abortController.signal,
    workspaceId: " ws-1 "
  });

  assert.deepEqual(listCalls, [
    {
      options: { signal: abortController.signal },
      request: {
        agentTargetId: "target-1",
        cursor: "20|session-2",
        limit: 100,
        searchQuery: "backend result"
      },
      workspaceId: "ws-1"
    }
  ]);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, "10|session-1");
  assert.equal(result.sessions[0]?.agentSessionId, "session-1");
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
            sessions: [],
            totalCount: 4
          },
          workspaceId
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const result = await service.listSessionSectionPage({
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
  assert.equal(result.totalCount, 4);
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
          pinned: {
            hasMore: false,
            totalCount: 1,
            sessions: [
              {
                ...{
                  activeTurnId: null,
                  latestTurnInteractions: [],
                  pendingInteractions: []
                },
                ...workspaceAgentSession({
                  status: "completed",
                  updatedAt: "2026-06-16T00:00:01.000Z"
                }),
                id: "pinned-session",
                pinnedAtUnixMs: 2000
              }
            ]
          },
          sections: [],
          workspaceId
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const result = await service.listSessionSections({
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
  assert.equal(result.pinned?.sessions[0]?.agentSessionId, "pinned-session");
  assert.equal(result.pinned?.sessions[0]?.pinnedAtUnixMs, 2000);
  assert.equal(result.pinned?.totalCount, 1);
});

test("WorkspaceAgentActivityService lists deletion candidates with exact section filters", async () => {
  const abortController = new AbortController();
  const calls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessionSectionDeletionCandidates: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["listWorkspaceAgentSessionSectionDeletionCandidates"]
        >[1],
        options: Parameters<
          TuttidClient["listWorkspaceAgentSessionSectionDeletionCandidates"]
        >[2]
      ) => {
        calls.push({ options, request, workspaceId });
        return {
          agentTargetId: "codex-target",
          excludePinned: true,
          sectionKey: "conversations",
          sessionIds: ["session-1", "session-2"],
          workspaceId
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const result = await service.listSessionSectionDeletionCandidates({
    agentTargetId: " codex-target ",
    excludePinned: true,
    sectionKey: "conversations",
    signal: abortController.signal,
    workspaceId: " ws-1 "
  });

  assert.deepEqual(calls, [
    {
      options: { signal: abortController.signal },
      request: {
        agentTargetId: "codex-target",
        excludePinned: true,
        sectionKey: "conversations"
      },
      workspaceId: "ws-1"
    }
  ]);
  assert.deepEqual(result.sessionIds, ["session-1", "session-2"]);
});

test("WorkspaceAgentActivityService deletes one exact session batch", async () => {
  const calls: unknown[] = [];
  let listCalls = 0;
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      deleteWorkspaceAgentSessionsBatch: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["deleteWorkspaceAgentSessionsBatch"]
        >[1]
      ) => {
        calls.push({ request, workspaceId });
        return {
          removedMessages: 3,
          removedSessionIds: ["session-1", "child-1"],
          removedSessions: 2
        };
      },
      listWorkspaceAgentSessions: async (workspaceId: string) => {
        listCalls += 1;
        return { hasMore: false, sessions: [], workspaceId };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  const engine = service.getSessionEngine("ws-1");
  await new Promise((resolve) => setImmediate(resolve));

  const result = await service.deleteSessionsBatch({
    sessionIds: ["session-1", "session-2"],
    workspaceId: "ws-1"
  });

  assert.deepEqual(calls, [
    {
      request: { sessionIds: ["session-1", "session-2"] },
      workspaceId: "ws-1"
    }
  ]);
  assert.deepEqual(result, {
    removedMessages: 3,
    removedSessionIds: ["session-1", "child-1"],
    removedSessions: 2
  });
  assert.equal(listCalls, 1);
  assert.deepEqual(engine.getSnapshot().sessionLifecycle.deletedSessionIds, {
    "child-1": true,
    "session-1": true
  });
});

test("WorkspaceAgentActivityService single delete uses the authoritative batch result without reloading", async () => {
  const calls: unknown[] = [];
  let listCalls = 0;
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      deleteWorkspaceAgentSessionsBatch: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["deleteWorkspaceAgentSessionsBatch"]
        >[1]
      ) => {
        calls.push({ request, workspaceId });
        return {
          removedMessages: 2,
          removedSessionIds: ["session-1", "child-1"],
          removedSessions: 2
        };
      },
      listWorkspaceAgentSessions: async (workspaceId: string) => {
        listCalls += 1;
        return { hasMore: false, sessions: [], workspaceId };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  const engine = service.getSessionEngine("ws-1");
  await new Promise((resolve) => setImmediate(resolve));

  const result = await service.deleteSession({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });

  assert.deepEqual(result, { removed: true });
  assert.deepEqual(calls, [
    {
      request: { sessionIds: ["session-1"] },
      workspaceId: "ws-1"
    }
  ]);
  assert.equal(listCalls, 1);
  assert.deepEqual(engine.getSnapshot().sessionLifecycle.deletedSessionIds, {
    "child-1": true,
    "session-1": true
  });
});

test("WorkspaceAgentActivityService.listPinnedSessionsPage forwards cursor to tuttid", async () => {
  const abortController = new AbortController();
  const pageCalls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentPinnedSessionPage: async (
        workspaceId: string,
        request: Parameters<
          TuttidClient["listWorkspaceAgentPinnedSessionPage"]
        >[1],
        options: Parameters<
          TuttidClient["listWorkspaceAgentPinnedSessionPage"]
        >[2]
      ) => {
        pageCalls.push({ options, request, workspaceId });
        return {
          page: {
            hasMore: false,
            totalCount: 1,
            sessions: [
              {
                ...{
                  activeTurnId: null,
                  latestTurnInteractions: [],
                  pendingInteractions: []
                },
                ...workspaceAgentSession({
                  status: "completed",
                  updatedAt: "2026-06-16T00:00:01.000Z"
                }),
                id: "pinned-session",
                pinnedAtUnixMs: 2000
              }
            ]
          },
          workspaceId
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const result = await service.listPinnedSessionsPage({
    workspaceId: "ws-1",
    agentTargetId: "claude-target",
    cursor: "2000|pinned-session",
    limit: 5,
    signal: abortController.signal
  });

  assert.deepEqual(pageCalls, [
    {
      workspaceId: "ws-1",
      request: {
        agentTargetId: "claude-target",
        cursor: "2000|pinned-session",
        limit: 5
      },
      options: { signal: abortController.signal }
    }
  ]);
  assert.equal(result.sessions[0]?.agentSessionId, "pinned-session");
  assert.equal(result.sessions[0]?.pinnedAtUnixMs, 2000);
  assert.equal(result.totalCount, 1);
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
  await new Promise((resolve) => setImmediate(resolve));

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

test("WorkspaceAgentActivityService.submitPlanDecision uses one semantic daemon transport", async () => {
  const calls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      submitWorkspaceAgentPlanDecision: async (...args: unknown[]) => {
        calls.push(args);
        return planDecisionResponse("completed");
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const result = await service.submitPlanDecision({
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    turnId: "turn-1",
    promptKind: "plan-implementation",
    action: "implement",
    idempotencyKey: "decision-1",
    requestId: "request-1"
  });

  assert.deepEqual(calls, [
    [
      "ws-1",
      "session-1",
      "turn-1",
      "request-1",
      {
        action: "implement",
        idempotencyKey: "decision-1",
        promptKind: "plan-implementation"
      }
    ]
  ]);
  assert.equal(result.operation.status, "completed");
});

function workspaceAgentSession(overrides: {
  activeTurn?: Record<string, unknown> | null;
  activeTurnId?: string | null;
  currentPhase?: string;
  provider?: string;
  runtimeContext?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  latestTurn?: Record<string, unknown> | null;
  status: string;
  submitAvailability?: Record<string, unknown>;
  turnLifecycle?: Record<string, unknown>;
  updatedAt?: string;
}): Record<string, unknown> {
  const updatedAtUnixMs = overrides.updatedAt
    ? Date.parse(overrides.updatedAt)
    : Date.parse("2026-06-16T00:00:00.000Z");
  const activeTurn =
    overrides.activeTurn !== undefined
      ? overrides.activeTurn
      : overrides.status === "working" || overrides.status === "waiting"
        ? workspaceAgentTurn({
            phase: overrides.status === "waiting" ? "waiting" : "running"
          })
        : null;
  const latestTurn =
    overrides.latestTurn !== undefined
      ? overrides.latestTurn
      : overrides.status === "completed" ||
          overrides.status === "failed" ||
          overrides.status === "canceled"
        ? workspaceAgentTurn({
            outcome: overrides.status,
            phase: "settled"
          })
        : null;
  return {
    activeTurn,
    activeTurnId:
      overrides.activeTurnId !== undefined
        ? overrides.activeTurnId
        : activeTurn
          ? "turn-1"
          : null,
    agentTargetId: null,
    capabilities: null,
    createdAtUnixMs: Date.parse("2026-06-16T00:00:00.000Z"),
    endedAtUnixMs: null,
    goal: null,
    id: "session-1",
    imported: false,
    provider: overrides.provider ?? "codex",
    providerSessionId: null,
    cwd: "/workspace",
    latestTurn,
    latestTurnInteractions: [],
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    railSectionKey: "conversations",
    resumable: true,
    settings: overrides.settings ?? {},
    title: "Session 1",
    updatedAtUnixMs,
    visible: true
  };
}

function workspaceAgentTurn(
  overrides: Partial<{
    outcome: "completed" | "failed" | "canceled";
    phase: "submitted" | "running" | "waiting" | "settling" | "settled";
  }> = {}
) {
  return {
    agentSessionId: "session-1",
    completedCommand: null,
    error: null,
    fileChanges: null,
    phase: "running" as const,
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 1,
    ...overrides,
    outcome: overrides.outcome ?? null,
    settledAtUnixMs: overrides.phase === "settled" ? 1 : null
  };
}

function planDecisionResponse(
  status: "prepared" | "leased" | "completed" | "failed"
) {
  return {
    operation: {
      agentSessionId: "session-1",
      idempotencyKey: "decision-1",
      operationId: "operation-1",
      requestId: "request-1",
      status,
      turnId: "turn-1",
      workspaceId: "ws-1"
    }
  };
}
