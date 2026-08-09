import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  type AgentActivitySession,
  type AgentActivityTurn,
  type AgentSessionEffectPort,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { NotificationMessage } from "@tutti-os/ui-notifications";
import {
  buildWorkspaceAgentOutcomeNotificationFromSettledTurn,
  createWorkspaceAgentOutcomeNotificationController,
  type WorkspaceAgentOutcomeForegroundNotification,
  workspaceAgentOutcomeNotificationKey
} from "./workspaceAgentOutcomeNotification.ts";

test("outcome builder projects canonical completed and failed settled turns", () => {
  assert.deepEqual(
    buildWorkspaceAgentOutcomeNotificationFromSettledTurn({
      session: canonicalSession(),
      turn: canonicalTurn("settled", "completed")
    }),
    {
      agentTargetId: "local:codex",
      agentSessionId: "session-1",
      conversationTitle: "Build feature",
      level: "success",
      provider: "codex",
      status: "completed",
      turnId: "turn-1",
      workspaceId: "ws-1"
    }
  );
  assert.equal(
    buildWorkspaceAgentOutcomeNotificationFromSettledTurn({
      session: canonicalSession(),
      turn: canonicalTurn("running")
    }),
    null
  );
  assert.equal(
    buildWorkspaceAgentOutcomeNotificationFromSettledTurn({
      session: canonicalSession(),
      turn: canonicalTurn("settled", "canceled")
    }),
    null
  );
});

test("controller treats settled turns already in the engine as history", () => {
  const engine = createTestEngine();
  dispatchSession(engine);
  dispatchTurn(engine, "settled", "completed");
  const harness = createOutcomeNotificationHarness(engine);

  assert.deepEqual(harness.foregroundNotifications, []);
  assert.deepEqual(harness.notifications, []);
  harness.controller.dispose();
});

test("controller notifies a new turn that first appears settled in one engine batch", async () => {
  const engine = createTestEngine();
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  harness.events[0]?.(turnUpdateEvent("settled", "completed"));
  dispatchSession(engine);
  dispatchTurn(engine, "settled", "completed");
  await settleOutcomeNotifications();

  assert.equal(harness.notifications.length, 1);
  harness.controller.dispose();
});

test("controller baselines settled turns received during initial hydration", async () => {
  const engine = createTestEngine();
  const harness = createOutcomeNotificationHarness(engine);

  requestWorkspaceReconcile(engine);
  dispatchSession(engine);
  dispatchTurn(engine, "settled", "completed", "historical-turn");
  assert.equal(harness.notifications.length, 0);

  completeWorkspaceReconcile(engine);
  assert.equal(harness.notifications.length, 0);

  dispatchTurn(engine, "running", undefined, "new-turn");
  dispatchTurn(engine, "settled", "completed", "new-turn");
  harness.events[0]?.(turnUpdateEvent("settled", "completed", "new-turn"));
  await settleOutcomeNotifications();
  assert.equal(harness.notifications.length, 1);
  harness.controller.dispose();
});

test("controller notifies once for a canonical running to settled transition", async () => {
  const engine = createTestEngine();
  dispatchSession(engine);
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  dispatchTurn(engine, "running");
  dispatchTurn(engine, "settled", "completed");
  harness.events[0]?.(turnUpdateEvent("settled", "completed"));
  dispatchTurn(engine, "settled", "completed");
  await settleOutcomeNotifications();

  assert.deepEqual(harness.foregroundNotifications, [
    {
      agentIconUrl: "agent-icon://codex",
      agentName: "Codex",
      agentSessionId: "session-1",
      body: "The agent finished this run.",
      closeLabel: "Close",
      conversationTitle: "Build feature",
      level: "success",
      provider: "codex",
      statusLabel: "Completed",
      turnId: "turn-1",
      workspaceId: "ws-1"
    }
  ]);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.title, "Build feature completed");

  harness.controller.dispose();
});

test("controller uses the exact Agent Target name and icon for extension outcomes", async () => {
  const engine = createTestEngine();
  dispatchSession(engine, {
    agentTargetId: "extension:kimi-code",
    provider: "acp:kimi-code"
  });
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  dispatchTurn(engine, "running");
  dispatchTurn(engine, "settled", "completed");
  harness.events[0]?.(turnUpdateEvent("settled", "completed"));
  await settleOutcomeNotifications();

  assert.deepEqual(harness.foregroundNotifications, [
    {
      agentIconUrl: "agent-icon://kimi-code",
      agentName: "Kimi Code",
      agentSessionId: "session-1",
      body: "The agent finished this run.",
      closeLabel: "Close",
      conversationTitle: "Build feature",
      level: "success",
      provider: "acp:kimi-code",
      statusLabel: "Completed",
      turnId: "turn-1",
      workspaceId: "ws-1"
    }
  ]);
  harness.controller.dispose();
});

test("controller waits for Agent Directory readiness before emitting outcomes", async () => {
  const engine = createTestEngine();
  dispatchSession(engine, {
    agentTargetId: "workspace-agent:reviewer"
  });
  markWorkspaceReconcileReady(engine);
  const directoryLoad = createDeferred<void>();
  const harness = createOutcomeNotificationHarness(engine, {
    directoryLoad: directoryLoad.promise
  });

  dispatchTurn(engine, "running");
  dispatchTurn(engine, "settled", "completed");
  harness.events[0]?.(turnUpdateEvent("settled", "completed"));

  assert.equal(harness.agentDirectoryLoadCalls.length, 1);
  assert.equal(harness.foregroundNotifications.length, 0);
  assert.deepEqual(harness.notifications, []);

  directoryLoad.resolve();
  await settleOutcomeNotifications();

  assert.equal(harness.notifications.length, 1);
  assert.equal(
    harness.foregroundNotifications[0]?.agentName,
    "Workspace Reviewer"
  );
  assert.equal(
    harness.foregroundNotifications[0]?.agentIconUrl,
    "agent-icon://workspace-reviewer"
  );
  harness.controller.dispose();
});

test("outcome notification key is stable per workspace session turn", () => {
  assert.equal(
    workspaceAgentOutcomeNotificationKey({
      agentSessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "ws-1"
    }),
    "workspace-agent-outcome:ws-1:session-1:turn-1"
  );
});

test("session messages never synthesize outcomes", () => {
  const engine = createTestEngine();
  dispatchSession(engine);
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  assert.deepEqual(harness.notifications, []);
  harness.controller.dispose();
});

test("controller uses the canonical engine session title", async () => {
  const engine = createTestEngine();
  dispatchSession(engine);
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  dispatchTurn(engine, "running");
  dispatchTurn(engine, "settled", "completed");
  harness.events[0]?.(turnUpdateEvent("settled", "completed"));
  await settleOutcomeNotifications();

  assert.equal(harness.notifications[0]?.title, "Build feature completed");
  harness.controller.dispose();
});

test("controller does not notify a historical settled turn hydrated after baseline", () => {
  const engine = createTestEngine();
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  dispatchSession(engine);
  dispatchTurn(engine, "settled", "completed", "historical-turn");

  assert.deepEqual(harness.foregroundNotifications, []);
  assert.deepEqual(harness.notifications, []);
  harness.controller.dispose();
});

function createTestEngine(): AgentSessionEngine {
  return createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: {
      effects: unexpectedSessionEffects(),
      execute: () => Promise.resolve(undefined),
      executePlanDecision: () =>
        Promise.reject(new Error("unexpected plan decision command")),
      kind: "typed"
    },
    identity: {
      origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
      workspaceId: "ws-1"
    },
    scheduler: {
      schedule() {
        return { cancel() {} };
      }
    }
  });
}

function unexpectedSessionEffects(): AgentSessionEffectPort {
  const reject = () => Promise.reject(new Error("unexpected session effect"));
  return {
    activateSession: reject,
    cancelTurn: reject,
    controlGoal: reject,
    deleteSessions: reject,
    renameSession: reject,
    respondToInteraction: reject,
    sendInput: reject,
    setSessionPinned: reject,
    updateSessionSettings: reject
  };
}

function dispatchSession(
  engine: AgentSessionEngine,
  overrides: Partial<AgentActivitySession> = {}
): void {
  engine.dispatch({
    session: { ...activitySession(), ...overrides },
    type: "session/upserted"
  });
}

function dispatchTurn(
  engine: AgentSessionEngine,
  phase: AgentActivityTurn["phase"],
  outcome?: AgentActivityTurn["outcome"],
  turnId = "turn-1"
): void {
  engine.dispatch({
    live: true,
    turn: canonicalTurn(phase, outcome, turnId),
    type: "turn/upserted"
  });
}

function requestWorkspaceReconcile(engine: AgentSessionEngine): void {
  engine.dispatch({
    type: "workspace/reconcileRequested",
    workspaceId: "ws-1"
  });
}

function completeWorkspaceReconcile(engine: AgentSessionEngine): void {
  const commandId =
    engine.getSnapshot().engineRuntime.workspaceReconcile.commandId;
  assert.ok(commandId);
  engine.dispatch({
    commandId,
    commandType: "engine/reconcileWorkspace",
    outcome: "succeeded",
    type: "engine/commandResult"
  });
}

function markWorkspaceReconcileReady(engine: AgentSessionEngine): void {
  requestWorkspaceReconcile(engine);
  completeWorkspaceReconcile(engine);
}

function canonicalSession() {
  const session = activitySession();
  const { activeTurn: _activeTurn, ...canonical } = session;
  return { ...canonical, activeTurnId: null };
}

function canonicalTurn(
  phase: AgentActivityTurn["phase"],
  outcome?: AgentActivityTurn["outcome"],
  turnId = "turn-1"
): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    origin: "user_prompt",
    outcome,
    phase,
    ...(phase === "settled" ? { settledAtUnixMs: 2 } : {}),
    startedAtUnixMs: 1,
    turnId,
    updatedAtUnixMs: 2
  };
}

function activitySession(): AgentActivitySession {
  return normalizeAgentActivitySession({
    ...{
      activeTurnId: null,
      latestTurnInteractions: [],
      pendingInteractions: []
    },
    activeTurn: null,
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    cwd: "/workspace",
    provider: "codex",
    title: "Build feature",
    workspaceId: "ws-1"
  });
}

function turnUpdateEvent(
  phase: AgentActivityTurn["phase"],
  outcome?: AgentActivityTurn["outcome"],
  turnId = "turn-1"
): unknown {
  return {
    data: {
      activeTurnId: phase === "settled" ? null : turnId,
      agentSessionId: "session-1",
      turn: canonicalTurn(phase, outcome, turnId),
      workspaceId: "ws-1"
    },
    eventType: "turn_update"
  };
}
function createOutcomeNotificationHarness(
  engine: AgentSessionEngine,
  options: {
    directoryLoad?: Promise<void>;
  } = {}
): {
  agentDirectoryLoadCalls: string[];
  controller: ReturnType<
    typeof createWorkspaceAgentOutcomeNotificationController
  >;
  events: Array<(event: unknown) => void>;
  foregroundNotifications: WorkspaceAgentOutcomeForegroundNotification[];
  notifications: NotificationMessage[];
} {
  const events: Array<(event: unknown) => void> = [];
  const foregroundNotifications: WorkspaceAgentOutcomeForegroundNotification[] =
    [];
  const notifications: NotificationMessage[] = [];
  const agentDirectoryLoadCalls: string[] = [];
  const controller = createWorkspaceAgentOutcomeNotificationController({
    agentDirectory: {
      getAgentPresentation({ agentTargetId }) {
        switch (agentTargetId) {
          case "local:codex":
            return {
              iconUrl: "agent-icon://codex",
              name: "Codex"
            };
          case "extension:kimi-code":
            return {
              iconUrl: "agent-icon://kimi-code",
              name: "Kimi Code"
            };
          case "workspace-agent:reviewer":
            return {
              iconUrl: "agent-icon://workspace-reviewer",
              name: "Workspace Reviewer"
            };
          default:
            return null;
        }
      },
      load() {
        agentDirectoryLoadCalls.push("load");
        return options.directoryLoad ?? Promise.resolve();
      }
    },
    foreground: {
      show(notification) {
        foregroundNotifications.push(notification);
      }
    },
    notifications: {
      notify(message) {
        notifications.push(message);
      }
    },
    translate(key, params) {
      if (key.endsWith("CompletedBody")) return "The agent finished this run.";
      if (key.endsWith("CompletedTitle")) return `${params?.title} completed`;
      if (key.endsWith("CompletedStatus")) return "Completed";
      if (key === "workspace.agentGui.fallbackAgentLabel") return "Agent";
      if (key === "common.close") return "Close";
      return key;
    },
    workspaceAgentActivityService: {
      getSessionEngine() {
        return engine;
      },
      onSessionEvent(workspaceId, listener) {
        assert.equal(workspaceId, "ws-1");
        events.push(listener);
        return () => {
          const index = events.indexOf(listener);
          if (index >= 0) events.splice(index, 1);
        };
      }
    },
    workspaceId: "ws-1"
  });
  return {
    agentDirectoryLoadCalls,
    controller,
    events,
    foregroundNotifications,
    notifications
  };
}

async function settleOutcomeNotifications(): Promise<void> {
  await Promise.resolve();
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve(value) {
      resolvePromise(value);
    }
  };
}
