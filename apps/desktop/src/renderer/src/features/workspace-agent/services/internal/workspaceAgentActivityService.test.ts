import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityUpdatedEventV1,
  CollaborationRun,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import { TuttidProtocolError } from "@tutti-os/client-tuttid-ts";
import {
  selectEnginePromptQueue,
  selectEngineSession,
  selectEngineTurnsForSession,
  selectSessionActivationPresentations,
  selectSessionAttention,
  selectSessionMutations
} from "@tutti-os/agent-activity-core";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { WorkspaceAgentActivityService } from "./workspaceAgentActivityService.ts";

function sessionDetailProjection(
  projection: Parameters<TuttidClient["getWorkspaceAgentSession"]>[2]
) {
  const resolved = projection ?? "full";
  return {
    lifecycleCapabilitiesProjected: resolved === "full",
    projection: resolved
  };
}

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

test("WorkspaceAgentActivityService applies authoritative Session detail in one engine notification", async () => {
  const rootSession = workspaceAgentSession({ status: "ready" });
  const childSession = {
    ...workspaceAgentSession({ status: "ready" }),
    id: "session-child",
    kind: "child",
    parentAgentSessionId: "session-1",
    rootAgentSessionId: "session-1"
  };
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        childSessions: [childSession],
        editRetry: workspaceAgentEditRetryAvailability(),
        session: rootSession,
        turns: [workspaceAgentTurn()]
      }),
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  await service.load("ws-1");
  const engine = service.getSessionEngine("ws-1");
  engine.dispatch({
    messages: [
      {
        agentSessionId: "session-1",
        kind: "text",
        messageId: "retracted-user",
        occurredAtUnixMs: 0,
        payload: { text: "original prompt" },
        role: "user",
        turnId: "turn-1",
        version: 1
      },
      {
        agentSessionId: "session-1",
        kind: "text",
        messageId: "retracted-answer",
        occurredAtUnixMs: 1,
        payload: { text: "old answer" },
        role: "assistant",
        turnId: "turn-1",
        version: 2
      }
    ],
    type: "message/snapshotReceived",
    workspaceId: "ws-1"
  });
  let notificationCount = 0;
  const unsubscribe = engine.subscribe(() => {
    notificationCount += 1;
  });

  await service.getSession("ws-1", "session-1");

  unsubscribe();
  assert.equal(notificationCount, 1);
  assert.ok(engine.getSnapshot().sessionLifecycle.sessionsById["session-1"]);
  assert.ok(
    engine.getSnapshot().sessionLifecycle.sessionsById["session-child"]
  );
  assert.equal(
    Object.values(engine.getSnapshot().sessionLifecycle.turnsById)[0]?.turnId,
    "turn-1"
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

test("WorkspaceAgentActivityService retries a failed focused message hydration and restores the transcript", async (t) => {
  const session = workspaceAgentSession({ status: "ready" });
  const synchronizationErrors: unknown[] = [];
  let messageReads = 0;
  let resolveHydrated!: () => void;
  const hydrated = new Promise<void>((resolve) => {
    resolveHydrated = resolve;
  });
  let resolveReadAfterRelease!: () => void;
  const readAfterRelease = new Promise<void>((resolve) => {
    resolveReadAfterRelease = resolve;
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        childSessions: [],
        editRetry: workspaceAgentEditRetryAvailability(),
        session,
        turns: []
      }),
      listWorkspaceAgentSessionMessages: async () => {
        messageReads += 1;
        if (messageReads === 1) {
          throw new Error("transient message read failure");
        }
        if (messageReads === 3) {
          resolveReadAfterRelease();
          throw new Error("failure after synchronization release");
        }
        resolveHydrated();
        return {
          hasMore: false,
          latestVersion: 1,
          messages: [
            {
              agentSessionId: "session-1",
              kind: "text",
              messageId: "message-1",
              occurredAtUnixMs: 1,
              payload: { text: "你是谁" },
              role: "user",
              sequence: 1,
              turnId: "turn-1",
              version: 1
            }
          ]
        };
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [session],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  t.after(() => service.dispose());
  await service.load("ws-1");

  const release = service.ensureSessionSynchronized({
    agentSessionId: "session-1",
    onError: (error) => synchronizationErrors.push(error),
    workspaceId: "ws-1"
  });
  t.after(release);
  await Promise.race([
    hydrated,
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("focused message hydration did not retry")),
        5_000
      );
      timeout.unref();
    })
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(messageReads, 2);
  assert.equal(synchronizationErrors.length, 1);
  assert.match(
    synchronizationErrors[0] instanceof Error
      ? synchronizationErrors[0].message
      : "",
    /transient message read failure/
  );
  assert.equal(
    service.getSnapshot("ws-1").sessionMessagesById["session-1"]?.[0]?.payload
      .text,
    "你是谁"
  );

  release();
  service.getSessionEngine("ws-1").dispatch({
    agentSessionId: "session-1",
    needsMessages: true,
    needsState: false,
    type: "session/reconcileRequested",
    workspaceId: "ws-1"
  });
  await readAfterRelease;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messageReads, 3, "a released focus lease must not retry");
  assert.equal(synchronizationErrors.length, 1);
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

test("Desktop Engine applies send results without a host-side Session dispatch", async (t) => {
  const readySession = workspaceAgentSession({ status: "ready" });
  const observedIntentTypes: string[] = [];
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
    runtimeApi: { logTerminalDiagnostic: async () => {} },
    sessionReplayEnabled: true
  });
  t.after(() => service.dispose());
  await service.load("ws-1");
  service.addSessionEngineActivityObserver("ws-1", {
    observeCommand() {},
    observeIntent(intent) {
      observedIntentTypes.push(intent.type);
    }
  });
  const engine = service.getSessionEngine("ws-1");

  assert.deepEqual(
    engine.submitPrompt({
      agentSessionId: "session-1",
      clientSubmitId: "submit-1",
      content: [{ type: "text", text: "continue" }]
    }),
    { accepted: true, queued: false }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(observedIntentTypes.includes("submit/requested"));
  assert.ok(observedIntentTypes.includes("engine/commandResult"));
  assert.equal(observedIntentTypes.includes("session/upserted"), false);
  assert.equal(
    selectEngineTurnsForSession(engine.getSnapshot(), "session-1")[0]?.phase,
    "submitted"
  );
});

test("WorkspaceAgentActivityService.cancelTurn delegates the exact turn", async () => {
  const calls: unknown[][] = [];
  const controller = new AbortController();
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      cancelWorkspaceAgentTurn: async (...args: unknown[]) => {
        calls.push(args);
        return { cancel: { canceled: true, reason: "turn_canceled" } };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const result = await service.cancelTurn({
    agentSessionId: "session-1",
    signal: controller.signal,
    turnId: "turn-1",
    workspaceId: " ws-1 "
  });

  assert.deepEqual(calls, [
    ["ws-1", "session-1", "turn-1", { signal: controller.signal }]
  ]);
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
    activationId: "submit-activate-codex",
    agentSessionId: "11111111-1111-4111-8111-111111111111",
    agentTargetId: "local:codex",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-activate-codex",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "hello" }],
    initialTuttiModeActivation: {
      effect: 73,
      speed: 61,
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    settings: {
      browserUse: false,
      model: "gpt-5",
      permissionModeId: "auto",
      planMode: true,
      reasoningEffort: "high",
      speed: "fast"
    },
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
      capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
      clientSubmitId: "submit-activate-codex",
      cwd: "/workspace",
      initialContent: [{ type: "text", text: "hello" }],
      initialDisplayPrompt: null,
      initialTuttiModeActivation: {
        effect: 73,
        speed: 61,
        source: "slash_command",
        status: "active"
      },
      browserUse: false,
      model: "gpt-5",
      noProject: null,
      permissionModeId: "auto",
      planMode: true,
      reasoningEffort: "high",
      speed: "fast",
      title: "Shared Codex",
      visible: true
    }
  });
});

test("Desktop Engine applies activation results through its authoritative projection", async (t) => {
  const observedIntentTypes: string[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      createWorkspaceAgentSession: async () =>
        workspaceAgentSession({ status: "created" })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} },
    sessionReplayEnabled: true
  });
  t.after(() => service.dispose());
  service.addSessionEngineActivityObserver("ws-1", {
    observeCommand() {},
    observeIntent(intent) {
      observedIntentTypes.push(intent.type);
    }
  });
  const engine = service.getSessionEngine("ws-1");

  assert.equal(
    engine.activateSession({
      agentSessionId: "session-1",
      agentTargetId: "local:codex",
      clientSubmitId: "submit-1",
      mode: "new",
      requestId: "activation-1"
    }),
    true
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(selectEngineSession(engine.getSnapshot(), "session-1"));
  assert.ok(observedIntentTypes.includes("activation/requested"));
  assert.ok(observedIntentTypes.includes("engine/commandResult"));
  assert.equal(observedIntentTypes.includes("session/upserted"), true);
});

test("Desktop Engine activation reports a failed conversation provider from the shared create effect", async (t) => {
  const refreshCalls: string[][] = [];
  const reporterEvents: ReporterEventInput[] = [];
  const service = new WorkspaceAgentActivityService({
    forceRefreshAgentProviderStatuses: async (providers) => {
      refreshCalls.push(providers);
      return {
        capturedAt: "2026-07-22T12:00:00.000Z",
        defaultProvider: "cursor",
        providers: [
          {
            actions: [],
            adapter: { command: [], installed: true },
            auth: { status: "required" },
            availability: { status: "auth_required" },
            cli: { installed: true },
            provider: "cursor",
            update: {
              capability: "unsupported",
              currentVersion: null,
              lastCheckedAt: null,
              latestVersion: null,
              reasonCode: null,
              source: null,
              unsupportedReason: "update_strategy_unsupported",
              updateAvailable: null
            }
          }
        ]
      };
    },
    reporterNow: () => 1_749_124_800_000,
    reporterService: {
      async trackEvents(events) {
        reporterEvents.push(...events);
      }
    },
    resolveAgentTargetProvider: (agentTargetId) =>
      agentTargetId === "target-cursor" ? "cursor" : null,
    tuttidClient: {
      createWorkspaceAgentSession: async () => {
        throw new Error("provider launch failed");
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  t.after(() => service.dispose());

  const engine = service.getSessionEngine("ws-1");
  assert.equal(
    engine.activateSession({
      agentSessionId: "session-failed",
      agentTargetId: "target-cursor",
      clientSubmitId: "submit-failed",
      initialContent: [{ type: "text", text: "hello" }],
      mode: "new",
      requestId: "activation-failed"
    }),
    true
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(refreshCalls, [["cursor"]]);
  const snapshot = reporterEvents.find(
    (event) => event.name === "agent.availability_snapshot"
  );
  assert.deepEqual(snapshot?.params, {
    authenticated: false,
    cli_installed: true,
    error_code: "agent_error_none",
    error_message: "",
    is_available: false,
    provider: "cursor",
    trigger: "conversation_start_failed",
    unavailable_reason: "not_authenticated"
  });
  const activationNodeResult = reporterEvents.find(
    (event) =>
      event.name === "agent.node_result" &&
      event.params?.node === "activate_session"
  );
  assert.deepEqual(
    {
      errorCode: activationNodeResult?.params?.error_code,
      flow: activationNodeResult?.params?.flow,
      status: activationNodeResult?.params?.status
    },
    {
      errorCode: "agent_session_create_failed",
      flow: "session_create",
      status: "failure"
    }
  );
});

test("WorkspaceAgentActivityService does not report a cached availability snapshot when the forced refresh fails", async () => {
  const reporterEvents: ReporterEventInput[] = [];
  const service = new WorkspaceAgentActivityService({
    forceRefreshAgentProviderStatuses: async () => null,
    reporterService: {
      async trackEvents(events) {
        reporterEvents.push(...events);
      }
    },
    resolveAgentTargetProvider: () => "cursor",
    tuttidClient: {
      createWorkspaceAgentSession: async () => {
        throw new Error("provider launch failed");
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  await assert.rejects(
    service.createSession({
      agentSessionId: "session-failed",
      agentTargetId: "target-cursor",
      clientSubmitId: "submit-failed",
      initialContent: [{ type: "text", text: "hello" }],
      workspaceId: "ws-1"
    }),
    /provider launch failed/
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    reporterEvents.some(
      (event) => event.name === "agent.availability_snapshot"
    ),
    false
  );
});

test("WorkspaceAgentActivityService confirms engine activation from the realtime session upsert", async (t) => {
  const createRequests: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      createWorkspaceAgentSession: async (
        _workspaceId: string,
        request: Parameters<TuttidClient["createWorkspaceAgentSession"]>[1]
      ) => {
        createRequests.push(request);
        return {
          ...workspaceAgentSession({ status: "completed" }),
          createdAtUnixMs: Date.now()
        };
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  t.after(() => service.dispose());
  const engine = service.getSessionEngine("ws-1");
  const requestedAtUnixMs = Date.now();
  engine.dispatch({
    type: "activation/requested",
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-1",
    expiresAtUnixMs: requestedAtUnixMs + 45_000,
    initialGoalControl: { action: "set", objective: "ship it" },
    isolation: "worktree",
    mode: "new",
    initialTuttiModeActivation: {
      effect: 73,
      speed: 61,
      source: "slash_command",
      status: "active"
    },
    requestedAtUnixMs,
    requestId: "activation-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(createRequests[0], {
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-1",
    cwd: null,
    isolation: "worktree",
    initialContent: [],
    initialDisplayPrompt: null,
    initialGoalControl: { action: "set", objective: "ship it" },
    initialTuttiModeActivation: {
      effect: 73,
      speed: 61,
      source: "slash_command",
      status: "active"
    },
    model: null,
    noProject: true,
    permissionModeId: null,
    planMode: null,
    reasoningEffort: null,
    speed: null,
    title: null,
    visible: true
  });

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

test("WorkspaceAgentActivityService reports session and message events from the shared engine command path", async (t) => {
  const reporterEvents: ReporterEventInput[] = [];
  const completedSession = workspaceAgentSession({ status: "completed" });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      createWorkspaceAgentSession: async () => completedSession,
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      }),
      sendWorkspaceAgentSessionInput: async () => ({
        kind: "turn",
        session: completedSession,
        turnId: "turn-2",
        turn: workspaceAgentTurn({ phase: "submitted" })
      })
    } as unknown as TuttidClient,
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterEvents.push(...events);
      }
    },
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  t.after(() => service.dispose());
  const engine = service.getSessionEngine("ws-1");
  const requestedAtUnixMs = Date.now();

  engine.dispatch({
    type: "activation/requested",
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    content: [{ type: "text", text: "Create the feature" }],
    initialDisplayPrompt:
      "/review [src/App.tsx](mention://file/src%2FApp.tsx?workspaceId=ws-1)",
    cwd: "/workspace",
    expiresAtUnixMs: requestedAtUnixMs + 45_000,
    mode: "new",
    requestedAtUnixMs,
    requestId: "activation-analytics-1",
    settings: {
      model: "gpt-5",
      permissionModeId: "auto"
    },
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  engine.dispatch({
    type: "submit/requested",
    agentSessionId: "session-1",
    clientSubmitId: "submit-2",
    content: [{ type: "text", text: "/review the result" }],
    expiresAtUnixMs: requestedAtUnixMs + 60_000,
    requestedAtUnixMs,
    submitDiagnostics: {
      blockCount: 1,
      promptLength: 18,
      queued: true,
      source: "agent-gui",
      submittedAtUnixMs: requestedAtUnixMs
    },
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    reporterEvents
      .filter((event) =>
        ["agent.session_started", "agent.message_sent"].includes(event.name)
      )
      .map((event) => ({ name: event.name, params: event.params })),
    [
      {
        name: "agent.session_started",
        params: {
          agent_session_id: "session-1",
          error_code: "agent_error_none",
          error_message: "",
          has_custom_model: false,
          has_project: true,
          permission_mode: "auto",
          provider: "codex",
          source: "launchpad"
        }
      },
      {
        name: "agent.message_sent",
        params: {
          agent_session_id: "session-1",
          conversation_index: 1,
          error_code: "agent_error_none",
          error_message: "",
          has_file_mention: true,
          has_slash_command: true,
          is_queued: false,
          provider: "codex"
        }
      },
      {
        name: "agent.message_sent",
        params: {
          agent_session_id: "session-1",
          conversation_index: 2,
          error_code: "agent_error_none",
          error_message: "",
          has_file_mention: false,
          has_slash_command: true,
          is_queued: false,
          provider: "codex"
        }
      }
    ]
  );
  assert.deepEqual(
    reporterEvents
      .filter((event) => event.name === "agent.node_result")
      .map((event) => ({
        flow: event.params?.flow,
        node: event.params?.node,
        status: event.params?.status
      })),
    [
      {
        flow: "session_create",
        node: "activate_session",
        status: "success"
      },
      {
        flow: "session_create",
        node: "session_started_reported",
        status: "success"
      },
      {
        flow: "session_create",
        node: "message_sent_reported",
        status: "success"
      },
      {
        flow: "message_send",
        node: "send_input_request",
        status: "success"
      },
      {
        flow: "message_send",
        node: "message_sent_reported",
        status: "success"
      }
    ]
  );
});

test("WorkspaceAgentActivityService does not wait for pending activation analytics", async (t) => {
  let analyticsCalls = 0;
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
    reporterService: {
      trackEvents: () => {
        analyticsCalls += 1;
        return new Promise<void>(() => {});
      }
    },
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  t.after(() => service.dispose());
  const engine = service.getSessionEngine("ws-1");
  const requestedAtUnixMs = Date.now();

  engine.dispatch({
    type: "activation/requested",
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-pending-analytics",
    content: [{ type: "text", text: "Create the feature" }],
    expiresAtUnixMs: requestedAtUnixMs + 1_000,
    mode: "new",
    requestedAtUnixMs,
    requestId: "activation-pending-analytics",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    selectSessionActivationPresentations(engine.getSnapshot())["session-1"]
      ?.status,
    "active"
  );
  assert.equal(analyticsCalls, 5);
});

test("WorkspaceAgentActivityService isolates rejected send analytics from the prompt command", async (t) => {
  let sendCalls = 0;
  const readySession = workspaceAgentSession({ status: "ready" });
  const submittedTurn = {
    ...workspaceAgentTurn({ phase: "submitted" }),
    turnId: "turn-analytics-rejected"
  };
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        childSessions: [],
        editRetry: workspaceAgentEditRetryAvailability(),
        session: readySession,
        turns: [submittedTurn]
      }),
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [readySession],
        workspaceId: "ws-1"
      }),
      sendWorkspaceAgentSessionInput: async () => {
        sendCalls += 1;
        return {
          kind: "turn",
          session: readySession,
          turnId: "turn-analytics-rejected",
          turn: submittedTurn
        };
      }
    } as unknown as TuttidClient,
    reporterService: {
      async trackEvents() {
        throw new Error("analytics unavailable");
      }
    },
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  t.after(() => service.dispose());
  const engine = service.getSessionEngine("ws-1");
  await new Promise((resolve) => setImmediate(resolve));
  const requestedAtUnixMs = Date.now();

  engine.dispatch({
    type: "submit/requested",
    agentSessionId: "session-1",
    clientSubmitId: "submit-rejected-analytics",
    content: [{ type: "text", text: "Continue" }],
    expiresAtUnixMs: requestedAtUnixMs + 45_000,
    requestedAtUnixMs,
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendCalls, 1);
  assert.equal(
    selectEnginePromptQueue(engine.getSnapshot(), "session-1")?.failureMessage,
    null
  );
  assert.equal(
    selectEnginePromptQueue(engine.getSnapshot(), "session-1")?.inFlight,
    null
  );
});

test("Desktop Engine preserves failed send node-result analytics", async (t) => {
  const reporterEvents: ReporterEventInput[] = [];
  const readySession = workspaceAgentSession({ status: "ready" });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [readySession],
        workspaceId: "ws-1"
      }),
      sendWorkspaceAgentSessionInput: async () => {
        throw new Error("send failed");
      }
    } as unknown as TuttidClient,
    reporterService: {
      async trackEvents(events) {
        reporterEvents.push(...events);
      }
    },
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  t.after(() => service.dispose());
  const engine = service.getSessionEngine("ws-1");
  await new Promise((resolve) => setImmediate(resolve));
  const requestedAtUnixMs = Date.now();

  engine.dispatch({
    type: "submit/requested",
    agentSessionId: "session-1",
    clientSubmitId: "submit-failed",
    content: [{ type: "text", text: "Continue" }],
    expiresAtUnixMs: requestedAtUnixMs + 45_000,
    requestedAtUnixMs,
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const sendNodeResult = reporterEvents.find(
    (event) =>
      event.name === "agent.node_result" &&
      event.params?.node === "send_input_request"
  );
  assert.deepEqual(
    {
      errorCode: sendNodeResult?.params?.error_code,
      flow: sendNodeResult?.params?.flow,
      status: sendNodeResult?.params?.status
    },
    {
      errorCode: "agent_runtime_exec_failed",
      flow: "message_send",
      status: "failure"
    }
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
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        session: loadedSession,
        childSessions: [],
        editRetry: workspaceAgentEditRetryAvailability(),
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
    activationId: "submit-activate-claude",
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

test("WorkspaceAgentActivityService does not reinterpret a failed Turn as activation failure", async () => {
  const controller = new AbortController();
  let existingActivationSignal: AbortSignal | undefined;
  const failedSession = workspaceAgentSession({
    latestTurn: {
      ...workspaceAgentTurn({ outcome: "failed", phase: "settled" }),
      error: { message: "Selected model is at capacity" }
    },
    status: "failed"
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      createWorkspaceAgentSession: async () => failedSession,
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => {
        existingActivationSignal = args[3]?.signal ?? undefined;
        return {
          ...sessionDetailProjection(args[2]),
          childSessions: [],
          editRetry: workspaceAgentEditRetryAvailability(),
          session: failedSession,
          turns: []
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const created = await service.activateSession({
    activationId: "submit-create-failed-turn",
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-create-failed-turn",
    initialContent: [{ type: "text", text: "Run it" }],
    mode: "new",
    visible: true,
    workspaceId: "ws-1"
  });
  const reopened = await service.activateSession({
    activationId: "activation-reopen-failed-turn",
    agentSessionId: "session-1",
    mode: "existing",
    signal: controller.signal,
    visible: true,
    workspaceId: "ws-1"
  });

  assert.deepEqual(created.activation, { mode: "new", status: "attached" });
  assert.equal(created.error, undefined);
  assert.deepEqual(reopened.activation, {
    mode: "existing",
    status: "already_attached"
  });
  assert.equal(reopened.error, undefined);
  assert.equal(existingActivationSignal, controller.signal);
});

test("WorkspaceAgentActivityService returns the authoritative canonical session after settings update", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  let requestSettings: unknown = null;
  const updatedSession = workspaceAgentSession({
    provider: "claude-code",
    settings: {
      browserUse: false,
      computerUse: true,
      model: "opus",
      planMode: true
    },
    status: "waiting"
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      updateWorkspaceAgentSessionSettings: async (
        ...args: Parameters<TuttidClient["updateWorkspaceAgentSessionSettings"]>
      ) => {
        requestSettings = args[2];
        requestSignal = args[3]?.signal ?? undefined;
        return updatedSession;
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const result = await service.updateSessionSettings({
    agentSessionId: "session-1",
    signal: controller.signal,
    settings: {
      browserUse: false,
      computerUse: true,
      model: "opus",
      planMode: true
    },
    workspaceId: "ws-1"
  });

  assert.equal(result.agentSessionId, "session-1");
  assert.equal(requestSignal, controller.signal);
  assert.deepEqual(requestSettings, {
    browserUse: false,
    model: "opus",
    permissionModeId: null,
    planMode: true,
    reasoningEffort: null,
    speed: null
  });
  assert.deepEqual(result.settings, {
    browserUse: false,
    computerUse: true,
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
    browserUse: false,
    computerUse: true,
    model: "opus",
    planMode: true
  });
});

test("Desktop Engine preserves session settings analytics and diagnostics", async (t) => {
  const reporterEvents: ReporterEventInput[] = [];
  const terminalDiagnostics: unknown[] = [];
  const previousSession = workspaceAgentSession({
    settings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "medium"
    },
    status: "ready"
  });
  const updatedSession = workspaceAgentSession({
    settings: {
      model: "custom:local-model",
      permissionModeId: "full-access",
      reasoningEffort: "high"
    },
    status: "ready"
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [previousSession],
        workspaceId: "ws-1"
      }),
      updateWorkspaceAgentSessionSettings: async () => updatedSession
    } as unknown as TuttidClient,
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterEvents.push(...events);
      }
    },
    runtimeApi: {
      async logTerminalDiagnostic(input) {
        terminalDiagnostics.push(input);
      }
    }
  });
  t.after(() => service.dispose());
  await service.load("ws-1");

  service.getSessionEngine("ws-1").updateSessionSettings({
    agentSessionId: "session-1",
    settings: {
      model: "custom:local-model",
      permissionModeId: "full-access",
      reasoningEffort: "high"
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    reporterEvents.map((event) => event.name),
    [
      "agent.settings.model_changed",
      "agent.settings.permission_mode_changed",
      "agent.settings.reasoning_effort_changed"
    ]
  );
  assert.deepEqual(
    terminalDiagnostics
      .map((entry) => (entry as { event: string }).event)
      .filter((event) => event.startsWith("agent.gui.composer_settings.")),
    [
      "agent.gui.composer_settings.update_requested",
      "agent.gui.composer_settings.changed"
    ]
  );
  assert.equal(
    service.getSessionEngine("ws-1").getSnapshot().sessionLifecycle
      .sessionsById["session-1"]?.settings?.model,
    "custom:local-model"
  );
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

  const defaultsInvalidationHandler = topicHandlers.get(
    "preferences.agent.composer.defaults.changed"
  );
  assert.ok(
    defaultsInvalidationHandler,
    "service must subscribe to target defaults invalidation"
  );
  const targetInvalidations: unknown[] = [];
  service.onComposerDefaultsInvalidated((event) => {
    targetInvalidations.push(event);
  });
  defaultsInvalidationHandler({ payload: { agentTargetId: "local:codex" } });
  assert.deepEqual(targetInvalidations, [{ agentTargetId: "local:codex" }]);
  await service.getComposerOptions({
    agentTargetId: "local:codex",
    provider: "codex",
    workspaceId: "ws-1"
  });
  assert.equal(composerOptionCalls, 3);
});

test("WorkspaceAgentActivityService starts session-event streams and forwards canonical turn events", async () => {
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
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
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
        editRetry: workspaceAgentEditRetryAvailability(),
        turns: []
      })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  let turnEventDelivered = false;
  const receivedTurnEvent = new Promise<unknown>((resolve) => {
    service.onSessionEvent(" ws-1 ", (event) => {
      turnEventDelivered = true;
      resolve(event);
    });
  });

  assert.deepEqual(subscriptions, [
    {
      scope: { workspaceId: "ws-1" },
      topic: "agent.activity.updated"
    },
    {
      scope: { workspaceId: "ws-1" },
      topic: "workspace.tuttimode.updated"
    },
    {
      scope: null,
      topic: "agent.model.catalog.invalidated"
    },
    {
      scope: null,
      topic: "preferences.agent.composer.defaults.changed"
    },
    {
      scope: null,
      topic: "connector.market.changed"
    },
    {
      scope: null,
      topic: "preferences.desktop.updated"
    }
  ]);
  assert.equal(connectCalls, 1);
  const activityUpdatedListener = listenersByTopic.get(
    "agent.activity.updated"
  );
  assert.ok(activityUpdatedListener);

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

  assert.equal(
    turnEventDelivered,
    false,
    "realtime activity must cross a microtask boundary before notifying listeners"
  );
  assert.deepEqual(await receivedTurnEvent, turnEvent);
  service.dispose();
});

test("WorkspaceAgentActivityService reconciles a realtime message version gap after its streaming debounce", async () => {
  const listenersByTopic = new Map<string, (event: unknown) => void>();
  const messageRequests: Array<Record<string, unknown>> = [];
  const diagnostics: Array<{
    details?: Record<string, unknown>;
    event?: string;
  }> = [];
  const session = workspaceAgentSession({ status: "completed" });
  const userMessage = {
    agentSessionId: "session-1",
    kind: "text",
    messageId: "user-1",
    occurredAtUnixMs: 1,
    payload: { text: "Please investigate" },
    role: "user",
    status: "completed",
    turnId: "turn-1",
    version: 1
  };
  const runningCompaction = {
    agentSessionId: "session-1",
    kind: "text",
    messageId: "compaction:turn-1",
    occurredAtUnixMs: 2,
    payload: {
      noticeCommand: "compact",
      noticeCommandStatus: "running",
      text: "Compacting context.",
      title: "Compacting context."
    },
    role: "assistant",
    semantics: {
      noticeCommand: "compact",
      noticeCommandStatus: "running"
    },
    status: "completed",
    turnId: "turn-1",
    version: 2
  };
  const completedCompaction = {
    ...runningCompaction,
    occurredAtUnixMs: 3,
    payload: {
      noticeCommand: "compact",
      noticeCommandStatus: "completed",
      text: "Context compacted.",
      title: "Context compacted."
    },
    semantics: {
      noticeCommand: "compact",
      noticeCommandStatus: "completed"
    },
    version: 3
  };
  const laterAssistantMessage = {
    agentSessionId: "session-1",
    kind: "text",
    messageId: "assistant-later",
    occurredAtUnixMs: 4,
    payload: { text: "Later output" },
    role: "assistant",
    status: "completed",
    turnId: "turn-1",
    version: 4
  };
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
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        session,
        childSessions: [],
        editRetry: workspaceAgentEditRetryAvailability(),
        turns: []
      }),
      listWorkspaceAgentSessionMessages: async (
        _workspaceId: string,
        _agentSessionId: string,
        request: Record<string, unknown>
      ) => {
        messageRequests.push(request);
        return messageRequests.length === 1
          ? {
              hasMore: false,
              latestVersion: 2,
              messages: [userMessage, runningCompaction]
            }
          : {
              hasMore: false,
              latestVersion: 4,
              messages: [completedCompaction, laterAssistantMessage]
            };
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [session],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async (payload) => {
        diagnostics.push(payload);
      }
    }
  });

  await service.load("ws-1");
  await service.listSessionMessages({
    agentSessionId: "session-1",
    order: "desc",
    workspaceId: "ws-1"
  });
  assert.equal(
    service
      .getSnapshot("ws-1")
      .sessionMessagesById["session-1"]?.find(
        (message) => message.messageId === "compaction:turn-1"
      )?.semantics?.noticeCommandStatus,
    "running"
  );

  const activityUpdated = listenersByTopic.get("agent.activity.updated");
  assert.ok(activityUpdated);
  activityUpdated({
    payload: {
      agentSessionId: "session-1",
      data: {
        acceptedCount: 1,
        agentSessionId: "session-1",
        eventType: "message_update",
        latestVersion: 4,
        messages: [laterAssistantMessage],
        workspaceId: "ws-1"
      },
      eventType: "message_update",
      workspaceId: "ws-1"
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 75));
  for (let attempt = 0; attempt < 10 && messageRequests.length < 2; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(messageRequests.length, 2);
  assert.equal(messageRequests[1]?.afterVersion, 2);
  assert.equal(
    service
      .getSnapshot("ws-1")
      .sessionMessagesById["session-1"]?.find(
        (message) => message.messageId === "compaction:turn-1"
      )?.semantics?.noticeCommandStatus,
    "completed"
  );
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.event === "agent.activity.reconcile.trace" &&
        entry.details?.traceEvent === "realtime.message_version_gap_detected" &&
        entry.details.cachedVersion === 2 &&
        entry.details.firstUnseenVersion === 4
    )
  );
});

test("WorkspaceAgentActivityService reconciles the synchronized priority session after reconnect", async (t) => {
  let connectionListener:
    | ((state: "connected" | "disconnected") => void)
    | undefined;
  const messageRequests: Array<Record<string, unknown>> = [];
  const session = workspaceAgentSession({ status: "completed" });
  const userMessage = {
    agentSessionId: "session-1",
    kind: "text",
    messageId: "user-1",
    occurredAtUnixMs: 1,
    payload: { text: "Please investigate" },
    role: "user",
    status: "completed",
    turnId: "turn-1",
    version: 1
  };
  const runningCompaction = {
    agentSessionId: "session-1",
    kind: "text",
    messageId: "compaction:turn-1",
    occurredAtUnixMs: 2,
    payload: {
      noticeCommand: "compact",
      noticeCommandStatus: "running"
    },
    role: "assistant",
    semantics: {
      noticeCommand: "compact",
      noticeCommandStatus: "running"
    },
    status: "completed",
    turnId: "turn-1",
    version: 2
  };
  const completedCompaction = {
    ...runningCompaction,
    occurredAtUnixMs: 3,
    payload: {
      noticeCommand: "compact",
      noticeCommandStatus: "completed"
    },
    semantics: {
      noticeCommand: "compact",
      noticeCommandStatus: "completed"
    },
    version: 3
  };
  const service = new WorkspaceAgentActivityService({
    eventStreamClient: {
      connect: async () => {},
      dispose: () => {},
      publishIntent: async () => {},
      subscribe: () => () => {},
      subscribeConnectionState: (
        listener: (state: "connected" | "disconnected") => void
      ) => {
        connectionListener = listener;
        return () => {};
      }
    } as never,
    tuttidClient: {
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        session,
        childSessions: [],
        editRetry: workspaceAgentEditRetryAvailability(),
        turns: []
      }),
      listWorkspaceAgentSessionMessages: async (
        _workspaceId: string,
        _agentSessionId: string,
        request: Record<string, unknown>
      ) => {
        messageRequests.push(request);
        return messageRequests.length === 1
          ? {
              hasMore: false,
              latestVersion: 2,
              messages: [userMessage, runningCompaction]
            }
          : {
              hasMore: false,
              latestVersion: 3,
              messages: [completedCompaction]
            };
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [session],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  t.after(() => service.dispose());

  await service.load("ws-1");
  assert.ok(connectionListener);
  connectionListener("connected");
  await new Promise((resolve) => setImmediate(resolve));

  const releasePriority = service.ensureSessionSynchronized({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });
  t.after(releasePriority);
  for (let attempt = 0; attempt < 10 && messageRequests.length < 1; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(messageRequests.length, 1);

  connectionListener("disconnected");
  connectionListener("connected");
  for (let attempt = 0; attempt < 10 && messageRequests.length < 2; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(messageRequests.length, 2);
  assert.equal(messageRequests[1]?.afterVersion, 2);
  assert.equal(
    service
      .getSnapshot("ws-1")
      .sessionMessagesById["session-1"]?.find(
        (message) => message.messageId === "compaction:turn-1"
      )?.semantics?.noticeCommandStatus,
    "completed"
  );
});

test("WorkspaceAgentActivityService projects WebSocket message deltas and yields to terminal canonical truth", async () => {
  const listenersByTopic = new Map<
    string,
    (event: AgentActivityUpdatedEventV1) => void
  >();
  const service = new WorkspaceAgentActivityService({
    eventStreamClient: {
      connect: async () => {},
      dispose: () => {},
      publishIntent: async () => {},
      subscribe: (
        topic: string,
        listener: (event: AgentActivityUpdatedEventV1) => void
      ) => {
        listenersByTopic.set(topic, listener);
        return () => listenersByTopic.delete(topic);
      },
      subscribeConnectionState: () => () => {}
    } as never,
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [workspaceAgentSession({ status: "working" })],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  await service.load("ws-1");
  await new Promise((resolve) => setImmediate(resolve));
  const activityEvent = (
    payload: AgentActivityUpdatedEventV1["payload"]
  ): AgentActivityUpdatedEventV1 => ({
    emittedAt: "2026-07-25T00:00:00.000Z",
    id: "event-1",
    payload,
    scope: { workspaceId: "ws-1" },
    topic: "agent.activity.updated",
    version: 2
  });
  let notifications = 0;
  let optimisticSessionEvents = 0;
  const unsubscribe = service.subscribe("ws-1", () => {
    notifications += 1;
  });
  const unsubscribeSessionEvents = service.onSessionEvent("ws-1", () => {
    optimisticSessionEvents += 1;
  });
  const activityUpdated = listenersByTopic.get("agent.activity.updated");
  assert.ok(activityUpdated);

  activityUpdated(
    activityEvent({
      workspaceId: "ws-1",
      agentSessionId: "session-1",
      eventType: "message_delta",
      data: {
        workspaceId: "ws-1",
        agentSessionId: "session-1",
        messageId: "message-1",
        turnId: "turn-1",
        role: "assistant",
        kind: "text",
        occurredAtUnixMs: 100,
        content: { operation: "set", value: "Hel" },
        status: "streaming"
      }
    })
  );
  for (let index = 0; index < 99; index += 1) {
    activityUpdated(
      activityEvent({
        workspaceId: "ws-1",
        agentSessionId: "session-1",
        eventType: "message_delta",
        data: {
          workspaceId: "ws-1",
          agentSessionId: "session-1",
          messageId: "message-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "text",
          occurredAtUnixMs: 101 + index,
          content: { operation: "append_text", text: "x" },
          status: "streaming"
        }
      })
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  let message =
    service.getSnapshot("ws-1").sessionMessagesById["session-1"]?.[0];
  assert.equal(message?.payload.text, `Hel${"x".repeat(99)}`);
  assert.equal(message?.version, 0);
  assert.equal(notifications, 0);
  assert.equal(optimisticSessionEvents, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(notifications, 1);
  assert.equal(optimisticSessionEvents, 1);

  activityUpdated(
    activityEvent({
      workspaceId: "ws-1",
      agentSessionId: "session-1",
      eventType: "message_update",
      data: {
        workspaceId: "ws-1",
        agentSessionId: "session-1",
        eventType: "message_update",
        acceptedCount: 1,
        latestVersion: 1,
        messages: [
          {
            agentSessionId: "session-1",
            kind: "text",
            messageId: "message-1",
            occurredAtUnixMs: 102,
            payload: {
              content: `Hel${"x".repeat(99)}`,
              text: `Hel${"x".repeat(99)}`
            },
            role: "assistant",
            sequence: 1,
            status: "completed",
            turnId: "turn-1",
            version: 1
          }
        ]
      }
    })
  );
  await new Promise((resolve) => setImmediate(resolve));

  message = service.getSnapshot("ws-1").sessionMessagesById["session-1"]?.[0];
  assert.equal(message?.payload.text, `Hel${"x".repeat(99)}`);
  assert.equal(message?.status, "completed");
  assert.equal(message?.version, 1);
  assert.ok(notifications >= 2);
  unsubscribe();
  unsubscribeSessionEvents();
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
  assert.equal(activeSubscriptions.size, 7);

  service.dispose();
  service.dispose();
  assert.equal(activeSubscriptions.size, 0);
});

test("WorkspaceAgentActivityService preserves realtime turn provenance for attention", async () => {
  const listenersByTopic = new Map<string, (event: unknown) => void>();
  let messageReconcileCalls = 0;
  const running = workspaceAgentSession({
    status: "working",
    userId: "local",
    updatedAt: "2026-07-14T00:00:01.000Z"
  });
  const settled = workspaceAgentSession({
    status: "completed",
    userId: "local",
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
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        session: settled,
        childSessions: [],
        editRetry: workspaceAgentEditRetryAvailability(),
        turns: [workspaceAgentTurn({ outcome: "completed", phase: "settled" })]
      }),
      listWorkspaceAgentSessionMessages: async () => {
        messageReconcileCalls += 1;
        return { hasMore: false, latestVersion: 0, messages: [] };
      },
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
  for (
    let attempt = 0;
    attempt < 10 && messageReconcileCalls === 0;
    attempt += 1
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(messageReconcileCalls > 0, true);
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
    ),
    null
  );
});

test("WorkspaceAgentActivityService preserves live provenance across a transient reconcile failure", async () => {
  const listenersByTopic = new Map<string, (event: unknown) => void>();
  let getCalls = 0;
  const running = workspaceAgentSession({
    status: "working",
    userId: "local",
    updatedAt: "2026-07-14T00:00:01.000Z"
  });
  const settled = workspaceAgentSession({
    status: "completed",
    userId: "local",
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
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => {
        getCalls += 1;
        if (getCalls === 2) {
          throw new TuttidProtocolError({
            code: "workspace_not_found",
            developerMessage: "workspace agent session not found",
            reason: "workspace_agent_session_not_found",
            statusCode: 404
          });
        }
        const returnedSession = getCalls === 1 ? running : settled;
        return {
          ...sessionDetailProjection(args[2]),
          childSessions: [],
          editRetry: workspaceAgentEditRetryAvailability(),
          turns:
            returnedSession === settled
              ? [
                  workspaceAgentTurn({
                    outcome: "completed",
                    phase: "settled"
                  })
                ]
              : []
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
        activeTurnId: null,
        turn: workspaceAgentTurn({
          outcome: "completed",
          phase: "settled"
        }),
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

  // The failed live read is retried once before the combined state/message
  // synchronization completes.
  assert.equal(getCalls >= 4, true);
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
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => {
        calls.push("getSession");
        return {
          ...sessionDetailProjection(args[2]),
          session: messagesResolved ? finalSession : staleSession,
          childSessions: [],
          editRetry: workspaceAgentEditRetryAvailability(),
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
  const reconcileDiagnostics = diagnostics.filter(
    (
      entry
    ): entry is {
      details: { traceEvent?: string };
      event: string;
      level?: string;
    } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { event?: unknown }).event === "agent.activity.reconcile.trace"
  );
  assert.ok(reconcileDiagnostics.every((entry) => entry.level === "debug"));
  assert.deepEqual(
    reconcileDiagnostics
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
    messageVersion: 1,
    rootAgentSessionId: "session-1",
    rootTurnId: "turn-1",
    parentAgentSessionId: "session-1",
    parentTurnId: "turn-1",
    parentToolCallId: "spawn-1",
    title: "Child 1"
  };
  const messageRequests: string[] = [];
  const messageRequestInputs: Array<{
    agentSessionId: string;
    request: Record<string, unknown>;
  }> = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        session: root,
        childSessions: [child],
        editRetry: workspaceAgentEditRetryAvailability(),
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
        agentSessionId: string,
        request: Record<string, unknown>
      ) => {
        messageRequests.push(agentSessionId);
        messageRequestInputs.push({ agentSessionId, request });
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
              sequence: 1,
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
  messageRequests.length = 0;
  service.ensureSessionSynchronized({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    messageRequests,
    ["session-1"],
    "an unchanged child cursor should skip its message request"
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

test("WorkspaceAgentActivityService catches up children that advance between detail reads", async () => {
  const root = workspaceAgentSession({ status: "ready" });
  const child = {
    ...workspaceAgentSession({ status: "working" }),
    id: "child-1",
    kind: "child",
    messageVersion: 1,
    parentAgentSessionId: "session-1",
    parentToolCallId: "spawn-1",
    parentTurnId: "turn-1",
    rootAgentSessionId: "session-1",
    rootTurnId: "turn-1"
  };
  let detailReads = 0;
  let advanceBetweenDetailReads = false;
  const childRequests: Array<Record<string, unknown>> = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async (
        _workspaceId: string,
        requestedSessionId: string,
        projection?: Parameters<TuttidClient["getWorkspaceAgentSession"]>[2]
      ) => {
        detailReads += 1;
        if (requestedSessionId === "child-1") {
          return {
            ...sessionDetailProjection(projection),
            session: {
              ...child,
              messageVersion: detailReads === 2 ? 3 : 2
            },
            childSessions: [],
            editRetry: workspaceAgentEditRetryAvailability(),
            turns: []
          };
        }
        return {
          ...sessionDetailProjection(projection),
          session: root,
          childSessions: [
            {
              ...child,
              messageVersion:
                advanceBetweenDetailReads && detailReads === 2 ? 2 : 1
            }
          ],
          editRetry: workspaceAgentEditRetryAvailability(),
          turns: []
        };
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [root],
        workspaceId: "ws-1"
      }),
      listWorkspaceAgentSessionMessages: async (
        _workspaceId: string,
        agentSessionId: string,
        request: Record<string, unknown>
      ) => {
        if (agentSessionId !== "child-1") {
          return { hasMore: false, latestVersion: 0, messages: [] };
        }
        childRequests.push(request);
        const version =
          request.afterVersion === 2 ? 3 : request.afterVersion === 1 ? 2 : 1;
        return {
          hasMore: false,
          latestVersion: version,
          messages: [
            {
              agentSessionId,
              kind: "text",
              messageId: "child-progress",
              occurredAtUnixMs: version,
              payload: { text: `v${version}` },
              role: "assistant",
              sequence: 1,
              turnId: "child-turn-1",
              version
            }
          ]
        };
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

  assert.deepEqual(childRequests, [
    { afterVersion: 0, beforeVersion: undefined, limit: 100, order: "desc" }
  ]);
  childRequests.length = 0;
  detailReads = 0;
  advanceBetweenDetailReads = true;
  service.ensureSessionSynchronized({
    agentSessionId: "session-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(childRequests, [
    {
      afterVersion: 1,
      beforeVersion: undefined,
      limit: undefined,
      order: "asc"
    }
  ]);
  assert.equal(
    service.getSnapshot("ws-1").sessionMessagesById["child-1"]?.[0]?.version,
    2
  );

  childRequests.length = 0;
  detailReads = 0;
  service.ensureSessionSynchronized({
    agentSessionId: "child-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(childRequests, [
    {
      afterVersion: 2,
      beforeVersion: undefined,
      limit: undefined,
      order: "asc"
    }
  ]);
  assert.equal(
    service.getSnapshot("ws-1").sessionMessagesById["child-1"]?.[0]?.version,
    3
  );
});

test("WorkspaceAgentActivityService loads the newest history page first", async () => {
  const requests: unknown[] = [];
  const session = workspaceAgentSession({ status: "ready" });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        session,
        childSessions: [],
        editRetry: workspaceAgentEditRetryAvailability(),
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
        return {
          hasMore: true,
          latestVersion: 200,
          messages: [
            {
              agentSessionId: "session-1",
              kind: "text",
              messageId: "message-200",
              occurredAtUnixMs: 200,
              payload: { text: "latest" },
              role: "assistant",
              turnId: "turn-200",
              version: 200
            }
          ]
        };
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
  assert.deepEqual(
    service.getSnapshot("ws-1").sessionMessageWindowsById?.["session-1"],
    {
      hasOlderMessages: true,
      oldestLoadedVersion: 200
    }
  );
});

test("WorkspaceAgentActivityService drains child incremental pages from its durable cursor", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const session = {
    ...workspaceAgentSession({ status: "ready" }),
    kind: "child",
    parentAgentSessionId: "root-1",
    rootAgentSessionId: "root-1"
  };
  let mode: "idle" | "incremental" | "seed" = "idle";
  const message = (version: number) => ({
    agentSessionId: "session-1",
    kind: "text",
    messageId: `message-${version}`,
    occurredAtUnixMs: version,
    payload: { text: String(version) },
    role: "assistant",
    sequence: version,
    turnId: `turn-${version}`,
    version
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => ({
        ...sessionDetailProjection(args[2]),
        session,
        childSessions: [],
        editRetry: workspaceAgentEditRetryAvailability(),
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
    order: "desc",
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
      executeSessionReconcileCommand(command: {
        agentSessionId: string;
        commandId: string;
        live: boolean;
        scope: "messages";
        type: "session/reconcile";
        workspaceId: string;
      }): Promise<unknown>;
    }
  ).executeSessionReconcileCommand({
    agentSessionId: "session-1",
    commandId: "test-child-incremental",
    live: false,
    scope: "messages",
    type: "session/reconcile",
    workspaceId: "ws-1"
  });

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
          cleanupFailedSessionIds: [],
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
    cleanupFailedSessionIds: [],
    removedMessages: 3,
    removedSessionIds: ["session-1", "child-1"],
    removedSessions: 2
  });
  assert.equal(listCalls, 1);
  assert.deepEqual(engine.getSnapshot().sessionLifecycle.deletedSessionIds, {
    "child-1": true,
    "session-1": true,
    "session-2": true
  });
});

test("WorkspaceAgentActivityService pins through the engine command port", async () => {
  const calls: unknown[] = [];
  const initial = workspaceAgentSession({ status: "completed" });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [initial],
        workspaceId: "ws-1"
      }),
      updateWorkspaceAgentSessionPin: async (
        workspaceId: string,
        agentSessionId: string,
        request: { pinned: boolean }
      ) => {
        calls.push({ agentSessionId, request, workspaceId });
        return {
          ...initial,
          pinnedAtUnixMs: 10,
          updatedAtUnixMs: Date.parse("2026-06-16T00:00:01.000Z")
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  const engine = service.getSessionEngine("ws-1");
  await new Promise((resolve) => setImmediate(resolve));

  const result = await service.setSessionPinned({
    agentSessionId: "session-1",
    pinned: true,
    workspaceId: "ws-1"
  });

  assert.deepEqual(calls, [
    {
      agentSessionId: "session-1",
      request: { pinned: true },
      workspaceId: "ws-1"
    }
  ]);
  assert.equal(result.pinnedAtUnixMs, 10);
  assert.equal(
    selectSessionMutations(engine.getSnapshot()).at(-1)?.status,
    "succeeded"
  );
});

test("WorkspaceAgentActivityService renames through the engine command port", async () => {
  const calls: unknown[] = [];
  const initial = workspaceAgentSession({ status: "completed" });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [initial],
        workspaceId: "ws-1"
      }),
      updateWorkspaceAgentSessionTitle: async (
        workspaceId: string,
        agentSessionId: string,
        request: { title: string },
        options?: { signal?: AbortSignal }
      ) => {
        calls.push({ agentSessionId, options, request, workspaceId });
        return {
          ...initial,
          title: request.title,
          updatedAtUnixMs: Date.parse("2026-06-16T00:00:01.000Z")
        };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  const engine = service.getSessionEngine("ws-1");
  await new Promise((resolve) => setImmediate(resolve));

  const result = await service.renameSession({
    agentSessionId: "session-1",
    title: "  Renamed session  ",
    workspaceId: "ws-1"
  });

  const call = calls[0] as
    | {
        agentSessionId: string;
        options?: { signal?: AbortSignal };
        request: { title: string };
        workspaceId: string;
      }
    | undefined;
  assert.deepEqual(
    call
      ? {
          agentSessionId: call.agentSessionId,
          request: call.request,
          workspaceId: call.workspaceId
        }
      : null,
    {
      agentSessionId: "session-1",
      request: { title: "Renamed session" },
      workspaceId: "ws-1"
    }
  );
  assert.ok(call?.options?.signal instanceof AbortSignal);
  assert.equal(result.title, "Renamed session");
  assert.equal(
    selectSessionMutations(engine.getSnapshot()).at(-1)?.status,
    "succeeded"
  );
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
          cleanupFailedSessionIds: [],
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

  assert.deepEqual(result, { cleanupFailed: false, removed: true });
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

test("WorkspaceAgentActivityService does not tombstone a missing reconcile without deletion evidence", async () => {
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
        data: {
          agentSessionId: string;
          eventType: "session_reconcile_required";
          lastEventUnixMs: number;
          workspaceId: string;
        };
        eventType: "session_reconcile_required";
        workspaceId: string;
      }): Promise<void>;
    }
  ).reconcileAgentActivityUpdate({
    agentSessionId: "ghost-session",
    data: {
      agentSessionId: "ghost-session",
      eventType: "session_reconcile_required",
      lastEventUnixMs: 1,
      workspaceId: "ws-1"
    },
    eventType: "session_reconcile_required",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    service.getSessionEngine("ws-1").getSnapshot().sessionLifecycle
      .deletedSessionIds["ghost-session"],
    undefined
  );
  assert.deepEqual(diagnostics.at(-1), {
    details: {
      agentSessionId: "ghost-session",
      error: "workspace agent session not found"
    },
    event: "agent.activity.reconcile_session_absent",
    level: "info",
    workspaceId: "ws-1"
  });
});

test("WorkspaceAgentActivityService preserves a pending new session when activity races create visibility", async (t) => {
  const diagnostics: unknown[] = [];
  const listenersByTopic = new Map<string, (event: unknown) => void>();
  let getSessionCalls = 0;
  let resolveCreate!: (value: Record<string, unknown>) => void;
  let resolveActivation!: () => void;
  const createResult = new Promise<Record<string, unknown>>((resolve) => {
    resolveCreate = resolve;
  });
  const activationResolved = new Promise<void>((resolve) => {
    resolveActivation = resolve;
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
      createWorkspaceAgentSession: async () => createResult,
      getWorkspaceAgentSession: async () => {
        getSessionCalls += 1;
        throw new TuttidProtocolError({
          code: "workspace_not_found",
          developerMessage: "workspace agent session not found",
          reason: "workspace_agent_session_not_found",
          statusCode: 404
        });
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async (payload) => {
        diagnostics.push(payload);
        if (
          payload.event === "agent.submit.trace" &&
          payload.details &&
          typeof payload.details === "object" &&
          "traceEvent" in payload.details &&
          payload.details.traceEvent === "activity_service.activate.resolved"
        ) {
          resolveActivation();
        }
      }
    }
  });
  t.after(() => service.dispose());
  const engine = service.getSessionEngine("ws-1");
  await new Promise((resolve) => setImmediate(resolve));
  const requestedAtUnixMs = Date.now();

  engine.dispatch({
    type: "activation/requested",
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    content: [{ type: "text", text: "hello" }],
    expiresAtUnixMs: requestedAtUnixMs + 45_000,
    mode: "new",
    requestedAtUnixMs,
    requestId: "activation-1",
    workspaceId: "ws-1"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const activityUpdated = listenersByTopic.get("agent.activity.updated");
  assert.ok(activityUpdated);
  activityUpdated({
    payload: {
      agentSessionId: "session-1",
      data: {
        agentSessionId: "session-1",
        eventType: "session_reconcile_required",
        lastEventUnixMs: requestedAtUnixMs,
        workspaceId: "ws-1"
      },
      eventType: "session_reconcile_required",
      workspaceId: "ws-1"
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const tuttiModeUpdated = listenersByTopic.get("workspace.tuttimode.updated");
  assert.ok(tuttiModeUpdated);
  tuttiModeUpdated({
    payload: {
      agentSessionId: "session-1",
      workspaceId: "ws-1"
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    engine.getSnapshot().sessionLifecycle.deletedSessionIds["session-1"],
    undefined
  );
  assert.equal(getSessionCalls, 0);
  assert.equal(
    diagnostics.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        "event" in entry &&
        entry.event === "agent.activity.reconcile_session_absent"
    ),
    false
  );

  resolveCreate({
    ...workspaceAgentSession({ status: "working" }),
    createdAtUnixMs: requestedAtUnixMs
  });
  await activationResolved;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    selectEngineSession(engine.getSnapshot(), "session-1")?.provider,
    "codex"
  );
  assert.equal(
    selectEngineSession(engine.getSnapshot(), "session-1")?.activeTurnId,
    "turn-1"
  );
  assert.equal(
    selectSessionActivationPresentations(engine.getSnapshot())["session-1"]
      ?.status,
    "active"
  );
});

test("WorkspaceAgentActivityService still reconciles a Tutti update for an existing session", async (t) => {
  const diagnostics: unknown[] = [];
  const listenersByTopic = new Map<string, (event: unknown) => void>();
  let getSessionCalls = 0;
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
        getSessionCalls += 1;
        throw new TuttidProtocolError({
          code: "workspace_not_found",
          developerMessage: "workspace agent session not found",
          reason: "workspace_agent_session_not_found",
          statusCode: 404
        });
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [workspaceAgentSession({ status: "ready" })],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async (payload) => {
        diagnostics.push(payload);
      }
    }
  });
  t.after(() => service.dispose());
  const engine = service.getSessionEngine("ws-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(selectEngineSession(engine.getSnapshot(), "session-1"));

  const tuttiModeUpdated = listenersByTopic.get("workspace.tuttimode.updated");
  assert.ok(tuttiModeUpdated);
  tuttiModeUpdated({
    payload: {
      agentSessionId: "session-1",
      workspaceId: "ws-1"
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getSessionCalls, 1);
  assert.deepEqual(diagnostics.at(-1), {
    details: {
      agentSessionId: "session-1",
      error: "workspace agent session not found"
    },
    event: "agent.activity.reconcile_session_absent",
    level: "info",
    workspaceId: "ws-1"
  });
});

test("WorkspaceAgentActivityService tombstones an explicit session deletion event", async () => {
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  const engine = service.getSessionEngine("ws-1");

  await (
    service as unknown as {
      reconcileAgentActivityUpdate(input: {
        agentSessionId: string;
        data: unknown;
        eventType: string;
        workspaceId: string;
      }): Promise<void>;
    }
  ).reconcileAgentActivityUpdate({
    agentSessionId: "session-1",
    data: {
      agentSessionId: "session-1",
      deletedAtUnixMs: 1,
      eventType: "session_deleted",
      workspaceId: "ws-1"
    },
    eventType: "session_deleted",
    workspaceId: "ws-1"
  });

  assert.equal(
    engine.getSnapshot().sessionLifecycle.deletedSessionIds["session-1"],
    true
  );
});

test("WorkspaceAgentActivityService rehydrates a restored session after clearing its deletion tombstone", async (t) => {
  const restoredSession = workspaceAgentSession({ status: "ready" });
  let detailCalls = 0;
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => {
        detailCalls += 1;
        return {
          ...sessionDetailProjection(args[2]),
          childSessions: [],
          editRetry: workspaceAgentEditRetryAvailability(),
          session: restoredSession,
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
        sessions: [restoredSession],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  t.after(() => service.dispose());
  const engine = service.getSessionEngine("ws-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(selectEngineSession(engine.getSnapshot(), "session-1"));

  const reconcile = (
    service as unknown as {
      reconcileAgentActivityUpdate(input: {
        agentSessionId: string;
        data: unknown;
        eventType: string;
        workspaceId: string;
      }): Promise<void>;
    }
  ).reconcileAgentActivityUpdate.bind(service);
  await reconcile({
    agentSessionId: "session-1",
    data: {
      agentSessionId: "session-1",
      deletedAtUnixMs: 1,
      eventType: "session_deleted",
      workspaceId: "ws-1"
    },
    eventType: "session_deleted",
    workspaceId: "ws-1"
  });
  assert.equal(selectEngineSession(engine.getSnapshot(), "session-1"), null);

  await reconcile({
    agentSessionId: "session-1",
    data: {
      agentSessionId: "session-1",
      eventType: "session_restored",
      restoredAtUnixMs: 2,
      workspaceId: "ws-1"
    },
    eventType: "session_restored",
    workspaceId: "ws-1"
  });
  for (
    let attempt = 0;
    attempt < 10 && !selectEngineSession(engine.getSnapshot(), "session-1");
    attempt += 1
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(
    engine.getSnapshot().sessionLifecycle.deletedSessionIds["session-1"],
    undefined
  );
  assert.ok(selectEngineSession(engine.getSnapshot(), "session-1"));
  assert.equal(detailCalls, 2);
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
  messageVersion?: number;
  status: string;
  submitAvailability?: Record<string, unknown>;
  turnLifecycle?: Record<string, unknown>;
  updatedAt?: string;
  userId?: string;
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
    forkedFrom: null,
    goal: null,
    goalSyncState: null,
    id: "session-1",
    imported: false,
    kind: "root",
    parentAgentSessionId: null,
    parentToolCallId: null,
    parentTurnId: null,
    provider: overrides.provider ?? "codex",
    providerSessionId: null,
    rootAgentSessionId: null,
    rootTurnId: null,
    cwd: "/workspace",
    latestTurn,
    latestTurnInteractions: [],
    messageVersion: overrides.messageVersion ?? 0,
    lifecycleCapabilities: { fork: false, forkThroughTurn: false },
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    railSectionKey: "conversations",
    resumable: true,
    settings: overrides.settings ?? {},
    title: "Session 1",
    tuttiModeActivation: null,
    updatedAtUnixMs,
    ...(overrides.userId ? { userId: overrides.userId } : {}),
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
    origin: "user_prompt" as const,
    phase: "running" as const,
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 1,
    ...overrides,
    outcome: overrides.outcome ?? null,
    settledAtUnixMs: overrides.phase === "settled" ? 1 : null
  };
}

function workspaceAgentEditRetryAvailability() {
  return {
    availableActions: [],
    eligible: false,
    historyRevision: 0,
    recoveryState: "completed" as const,
    supported: false
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
test("WorkspaceAgentActivityService exposes durable AutomationRule session overrides", async () => {
  const calls: unknown[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      async listAutomationRules(workspaceId: string) {
        calls.push(["list", workspaceId]);
        return {
          rules: [
            {
              id: "rule-review",
              name: "Review completed work",
              enabled: true,
              trigger: "on_task_complete"
            }
          ]
        };
      },
      async getAgentSessionAutomationRuleOverride(
        workspaceId: string,
        agentSessionId: string
      ) {
        calls.push(["get", workspaceId, agentSessionId]);
        return {
          agentSessionId,
          workspaceId,
          disabled: false,
          ruleIds: ["rule-review"]
        };
      },
      async setAgentSessionAutomationRuleOverride(
        workspaceId: string,
        agentSessionId: string,
        request: { disabled: boolean; ruleIds: string[] }
      ) {
        calls.push(["set", workspaceId, agentSessionId, request]);
        return { agentSessionId, workspaceId, ...request };
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  assert.deepEqual(
    await service.listAutomationRules({ workspaceId: " ws-1 " }),
    {
      rules: [
        {
          // The retired action split no longer travels on the daemon
          // contract; the runtime summary keeps an empty placeholder.
          action: "",
          enabled: true,
          id: "rule-review",
          name: "Review completed work",
          trigger: "on_task_complete"
        }
      ]
    }
  );
  assert.deepEqual(
    await service.getAutomationRuleOverride({
      agentSessionId: "session-1",
      workspaceId: " ws-1 "
    }),
    {
      agentSessionId: "session-1",
      workspaceId: "ws-1",
      disabled: false,
      ruleIds: ["rule-review"]
    }
  );
  assert.deepEqual(
    await service.setAutomationRuleOverride({
      agentSessionId: "session-1",
      workspaceId: " ws-1 ",
      disabled: true,
      ruleIds: []
    }),
    {
      agentSessionId: "session-1",
      workspaceId: "ws-1",
      disabled: true,
      ruleIds: []
    }
  );
  assert.deepEqual(calls, [
    ["list", "ws-1"],
    ["get", "ws-1", "session-1"],
    ["set", "ws-1", "session-1", { disabled: true, ruleIds: [] }]
  ]);
});

function collaborationRunResponseBody(
  overrides: Record<string, unknown> = {}
): CollaborationRun {
  return {
    id: "run-1",
    workspaceId: "ws-1",
    mode: "consult",
    triggerSource: "user",
    triggerReason: "composer_consult",
    sourceSessionId: "session-1",
    modelPlanId: "plan-1",
    model: "kimi-k2",
    status: "completed",
    adoption: "pending",
    usage: { inputTokens: 812, outputTokens: 96 },
    durationMs: 5200,
    startedAt: "2026-07-12T00:00:00.000Z",
    completedAt: "2026-07-12T00:00:05.200Z",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:05.200Z",
    ...overrides
  } as CollaborationRun;
}

test("WorkspaceAgentActivityService.setCollaborationAdoption delegates to the canonical tuttid client", async () => {
  const calls: Parameters<TuttidClient["setCollaborationRunAdoption"]>[] = [];
  const abortController = new AbortController();
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      async setCollaborationRunAdoption(
        ...args: Parameters<TuttidClient["setCollaborationRunAdoption"]>
      ) {
        calls.push(args);
        return collaborationRunResponseBody({ adoption: "adopted" });
      }
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const run = await service.setCollaborationAdoption({
    adoption: "adopted",
    agentSessionId: "session-1",
    runId: "run-1",
    signal: abortController.signal,
    workspaceId: " ws-1 "
  });

  assert.deepEqual(calls, [
    [
      "ws-1",
      "run-1",
      { adoption: "adopted" },
      { signal: abortController.signal }
    ]
  ]);
  assert.equal(run.adoption, "adopted");
  assert.equal(run.workspaceId, "ws-1");
});

test("WorkspaceAgentActivityService engine owns edit retry and authoritative reconcile", async () => {
  const editRetryCalls: Parameters<TuttidClient["editRetry"]>[] = [];
  let detailCalls = 0;
  let messageCalls = 0;
  const session = workspaceAgentSession({
    latestTurn: workspaceAgentTurn({
      outcome: "completed",
      phase: "settled"
    }),
    status: "completed"
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      editRetry: async (...args: Parameters<TuttidClient["editRetry"]>) => {
        editRetryCalls.push(args);
        return {
          historyRevision: 2,
          operationId: "operation-1",
          replacementTurnId: "turn-replacement",
          retractedTurnId: "turn-1",
          state: "completed"
        };
      },
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => {
        detailCalls += 1;
        return {
          ...sessionDetailProjection(args[2]),
          childSessions: [],
          editRetry: {
            availableActions: [],
            eligible: false,
            historyRevision: 2,
            recoveryState: "prepared",
            supported: true
          },
          session,
          turns: []
        };
      },
      listWorkspaceAgentSessionMessages: async () => {
        messageCalls += 1;
        return {
          hasMore: false,
          latestVersion: 1,
          messages: [
            {
              agentSessionId: "session-1",
              kind: "text",
              messageId: "replacement-answer",
              occurredAtUnixMs: 2,
              payload: { text: "replacement answer" },
              role: "assistant",
              turnId: "turn-replacement",
              version: 1
            }
          ]
        };
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [session],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    }
  });

  const engine = service.getSessionEngine("ws-1");
  engine.dispatch({
    agentSessionId: "session-1",
    availability: {
      availableActions: [],
      eligible: true,
      historyRevision: 1,
      recoveryState: "prepared",
      supported: true,
      turnId: "turn-1"
    },
    type: "editRetry/availabilityReceived",
    workspaceId: "ws-1"
  });
  engine.dispatch({
    agentSessionId: "session-1",
    editedText: "edited prompt",
    turnId: "turn-1",
    type: "editRetry/requested",
    workspaceId: "ws-1"
  });
  for (let attempt = 0; attempt < 20 && messageCalls === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const clientOperationId =
    editRetryCalls[0]?.[3].clientOperationId ?? "missing";
  assert.match(clientOperationId, /^edit-retry-[0-9a-f]{8}-[0-9a-f]{8}$/);
  const commandSignal = editRetryCalls[0]?.[4]?.signal;
  assert.equal(commandSignal?.aborted, false);

  assert.deepEqual(editRetryCalls, [
    [
      "ws-1",
      "session-1",
      "turn-1",
      {
        clientOperationId,
        editedText: "edited prompt",
        expectedHistoryRevision: 1
      },
      { signal: commandSignal }
    ]
  ]);
  assert.equal(detailCalls >= 1, true);
  assert.equal(messageCalls, 2);
  assert.equal(
    engine.getSnapshot().editRetry.operationBySessionId["session-1"]?.status,
    "succeeded"
  );
  assert.equal(
    engine.getSnapshot().editRetry.availabilityBySessionId["session-1"]
      ?.historyRevision,
    2
  );
  assert.deepEqual(
    service
      .getSnapshot("ws-1")
      .sessionMessagesById["session-1"]?.map((message) => message.messageId),
    ["replacement-answer"]
  );
});

test("WorkspaceAgentActivityService retries a transient edit-retry projection failure", async () => {
  let detailCalls = 0;
  let messageCalls = 0;
  const replacementTurn = {
    ...workspaceAgentTurn({ outcome: "completed", phase: "settled" }),
    turnId: "turn-replacement"
  };
  const session = workspaceAgentSession({
    latestTurn: replacementTurn,
    status: "completed"
  });
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      editRetry: async () => ({
        historyRevision: 2,
        operationId: "operation-retry",
        replacementTurnId: "turn-replacement",
        retractedTurnId: "turn-1",
        state: "completed"
      }),
      getWorkspaceAgentSession: async (
        ...args: Parameters<TuttidClient["getWorkspaceAgentSession"]>
      ) => {
        detailCalls += 1;
        if (detailCalls === 1) throw new Error("temporary detail failure");
        return {
          ...sessionDetailProjection(args[2]),
          childSessions: [],
          editRetry: {
            availableActions: [],
            eligible: false,
            historyRevision: 2,
            recoveryState: "prepared",
            supported: true
          },
          session,
          turns: [replacementTurn]
        };
      },
      listWorkspaceAgentSessionMessages: async () => {
        messageCalls += 1;
        return {
          hasMore: false,
          latestVersion: 1,
          messages: [
            {
              agentSessionId: "session-1",
              kind: "text",
              messageId: "replacement-answer",
              occurredAtUnixMs: 2,
              payload: { text: "replacement answer" },
              role: "assistant",
              turnId: "turn-replacement",
              version: 1
            }
          ]
        };
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [session],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });

  const engine = service.getSessionEngine("ws-1");
  engine.dispatch({
    agentSessionId: "session-1",
    availability: {
      availableActions: [],
      eligible: true,
      historyRevision: 1,
      recoveryState: "prepared",
      supported: true,
      turnId: "turn-1"
    },
    type: "editRetry/availabilityReceived",
    workspaceId: "ws-1"
  });
  engine.dispatch({
    agentSessionId: "session-1",
    editedText: "edited prompt",
    turnId: "turn-1",
    type: "editRetry/requested",
    workspaceId: "ws-1"
  });

  for (
    let attempt = 0;
    attempt < 30 &&
    engine.getSnapshot().editRetry.operationBySessionId["session-1"]?.status !==
      "succeeded";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(
    engine.getSnapshot().editRetry.operationBySessionId["session-1"]?.status,
    "succeeded"
  );
  assert.equal(detailCalls >= 3, true);
  assert.equal(messageCalls, 2);
  assert.deepEqual(
    service
      .getSnapshot("ws-1")
      .sessionMessagesById["session-1"]?.map((message) => message.messageId),
    ["replacement-answer"]
  );
  service.dispose();
});

function activityRecorderHarness() {
  const appended: { recordingId: string; types: string[] }[] = [];
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      appendAgentSessionRecordingActivityEvents: async (
        _workspaceId: string,
        recordingId: string,
        body: { events: { type: string }[] }
      ) => {
        appended.push({
          recordingId,
          types: body.events.map((event) => event.type)
        });
      },
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} },
    sessionReplayEnabled: true
  });
  return { appended, service };
}

test("WorkspaceAgentActivityService disabled composition creates no replay state", async () => {
  const service = new WorkspaceAgentActivityService({
    tuttidClient: {
      listWorkspaceAgentSessions: async () => ({
        hasMore: false,
        sessions: [],
        workspaceId: "ws-1"
      })
    } as unknown as TuttidClient,
    runtimeApi: { logTerminalDiagnostic: async () => {} }
  });
  const engine = service.getSessionEngine("ws-1");
  await service.load("ws-1");
  engine.dispatch({
    agentSessionId: "session-1",
    promptId: "prompt-idle",
    type: "queue/removed"
  });

  assert.throws(
    () => service.startSessionActivityEventRecording("ws-1", "recording-1"),
    /agent_session_replay_not_composed/
  );
  assert.throws(
    () =>
      service.addSessionEngineActivityObserver("ws-1", {
        observeCommand() {},
        observeIntent() {}
      }),
    /agent_session_replay_not_composed/
  );
  service.dispose();
});

test("WorkspaceAgentActivityService keeps enabled observer state lazy without a recording", async () => {
  const { appended, service } = activityRecorderHarness();
  const observedIntentTypes: string[] = [];
  const removeObserver = service.addSessionEngineActivityObserver("ws-1", {
    observeCommand: () => {},
    observeIntent: (intent) => {
      observedIntentTypes.push(intent.type);
    }
  });
  const engine = service.getSessionEngine("ws-1");
  await service.load("ws-1");

  engine.dispatch({
    agentSessionId: "session-1",
    promptId: "prompt-idle",
    type: "queue/removed"
  });

  assert.equal(observedIntentTypes.includes("queue/removed"), true);
  assert.deepEqual(appended, []);
  removeObserver();
  service.dispose();
});

test("WorkspaceAgentActivityService constructs the recorder at start and drops it after seal or discard", async () => {
  const { appended, service } = activityRecorderHarness();
  const engine = service.getSessionEngine("ws-1");
  await service.load("ws-1");

  engine.dispatch({
    agentSessionId: "session-1",
    promptId: "prompt-before",
    type: "queue/removed"
  });

  service.startSessionActivityEventRecording("ws-1", "recording-1");
  engine.dispatch({
    agentSessionId: "session-1",
    promptId: "prompt-recorded",
    type: "queue/removed"
  });
  await service.sealSessionActivityEventRecording("ws-1", "recording-1");

  assert.deepEqual(
    appended.flatMap((batch) => batch.types),
    ["queue/removed"]
  );
  assert.equal(
    appended.every((batch) => batch.recordingId === "recording-1"),
    true
  );

  service.startSessionActivityEventRecording("ws-1", "recording-2");
  service.discardSessionActivityEventRecording("ws-1", "recording-2");

  engine.dispatch({
    agentSessionId: "session-1",
    promptId: "prompt-after",
    type: "queue/removed"
  });
  assert.equal(appended.length, 1);
  service.dispose();
});
