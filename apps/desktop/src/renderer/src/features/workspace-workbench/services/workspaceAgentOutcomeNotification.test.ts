import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  type AgentActivitySession,
  type AgentActivityTurn,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { NotificationMessage } from "@tutti-os/ui-notifications";
import {
  buildWorkspaceAgentOutcomeNotificationFromSettledTurn,
  createWorkspaceAgentOutcomeNotificationController
} from "./workspaceAgentOutcomeNotification.ts";

test("outcome builder projects canonical completed and failed settled turns", () => {
  assert.deepEqual(
    buildWorkspaceAgentOutcomeNotificationFromSettledTurn({
      conversationTitle: "Build feature",
      session: canonicalSession(),
      turn: canonicalTurn("settled", "completed")
    }),
    {
      agentSessionId: "session-1",
      conversationTitle: "Build feature",
      level: "success",
      provider: "codex",
      status: "completed",
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

test("controller notifies a new turn that first appears settled in one engine batch", () => {
  const engine = createTestEngine();
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  harness.events[0]?.(turnUpdateEvent("settled", "completed"));
  dispatchSession(engine);
  dispatchTurn(engine, "settled", "completed");

  assert.equal(harness.notifications.length, 1);
  harness.controller.dispose();
});

test("controller baselines settled turns received during initial hydration", () => {
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
  assert.equal(harness.notifications.length, 1);
  harness.controller.dispose();
});

test("controller notifies once for a canonical running to settled transition", () => {
  const engine = createTestEngine();
  dispatchSession(engine);
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  dispatchTurn(engine, "running");
  dispatchTurn(engine, "settled", "completed");
  harness.events[0]?.(turnUpdateEvent("settled", "completed"));
  dispatchTurn(engine, "settled", "completed");

  assert.deepEqual(harness.foregroundNotifications, [
    {
      agentName: "Codex",
      agentSessionId: "session-1",
      body: "The agent finished this run.",
      closeLabel: "Close",
      conversationTitle: "Build feature",
      level: "success",
      provider: "codex",
      statusLabel: "Completed",
      workspaceId: "ws-1"
    }
  ]);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.title, "Build feature completed");

  harness.controller.dispose();
});

test("session messages never synthesize outcomes", () => {
  const engine = createTestEngine();
  dispatchSession(engine);
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  assert.deepEqual(harness.notifications, []);
  harness.controller.dispose();
});

test("controller uses the canonical engine session title", () => {
  const engine = createTestEngine();
  dispatchSession(engine);
  markWorkspaceReconcileReady(engine);
  const harness = createOutcomeNotificationHarness(engine);

  dispatchTurn(engine, "running");
  dispatchTurn(engine, "settled", "completed");
  harness.events[0]?.(turnUpdateEvent("settled", "completed"));

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
    commandPort: { execute: () => Promise.resolve(undefined) },
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

function dispatchSession(engine: AgentSessionEngine): void {
  engine.dispatch({ session: activitySession(), type: "session/upserted" });
}

function dispatchTurn(
  engine: AgentSessionEngine,
  phase: AgentActivityTurn["phase"],
  outcome?: AgentActivityTurn["outcome"],
  turnId = "turn-1"
): void {
  engine.dispatch({
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
function createOutcomeNotificationHarness(engine: AgentSessionEngine): {
  controller: ReturnType<
    typeof createWorkspaceAgentOutcomeNotificationController
  >;
  events: Array<(event: unknown) => void>;
  foregroundNotifications: unknown[];
  notifications: NotificationMessage[];
} {
  const events: Array<(event: unknown) => void> = [];
  const foregroundNotifications: unknown[] = [];
  const notifications: NotificationMessage[] = [];
  const controller = createWorkspaceAgentOutcomeNotificationController({
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
  return { controller, events, foregroundNotifications, notifications };
}
