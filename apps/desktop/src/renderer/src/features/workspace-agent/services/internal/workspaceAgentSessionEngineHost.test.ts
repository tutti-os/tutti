import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivitySession,
  EngineExternalCommand,
  EngineIntent,
  SessionAcknowledgeForkObservedCommand,
  TuttiModeActivationUpdateCommand
} from "@tutti-os/agent-activity-core";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import {
  createWorkspaceAgentSessionEngineHost,
  executeWorkspaceAgentForkObservedAckCommand,
  executeWorkspaceAgentTuttiModeUpdateCommand
} from "./workspaceAgentSessionEngineHost.ts";

test("fork observation ACK forwards the durable operation identity and abort signal", async () => {
  const controller = new AbortController();
  const calls: unknown[] = [];
  const command = {
    commandId: "ack-command",
    correlationId: "local-mutation",
    operationId: "durable-operation",
    timeoutMs: 10_000,
    type: "session/ackForkObserved",
    workspaceId: "workspace-1"
  } satisfies SessionAcknowledgeForkObservedCommand;

  await executeWorkspaceAgentForkObservedAckCommand(
    {
      async acknowledgeWorkspaceAgentSessionForkOperation(
        workspaceId,
        operationId,
        options
      ) {
        calls.push({ operationId, options, workspaceId });
        return { acknowledged: true };
      }
    },
    command,
    controller.signal
  );

  assert.deepEqual(calls, [
    {
      operationId: "durable-operation",
      options: { signal: controller.signal },
      workspaceId: "workspace-1"
    }
  ]);
});

test("Tutti mode update command preserves CAS revision and zero preferences", async () => {
  const controller = new AbortController();
  let received: unknown;
  await executeWorkspaceAgentTuttiModeUpdateCommand(
    {
      updateTuttiModeActivation: async (input) => {
        received = input;
        return {} as never;
      }
    },
    {
      agentSessionId: "session-1",
      commandId: "tutti-1",
      expectedRevision: 3,
      effect: 0,
      speed: 0,
      source: "slash_command",
      status: "active",
      type: "tuttiMode/update",
      workspaceId: "workspace-1"
    } satisfies TuttiModeActivationUpdateCommand,
    controller.signal
  );

  assert.deepEqual(received, {
    agentSessionId: "session-1",
    expectedRevision: 3,
    effect: 0,
    speed: 0,
    signal: controller.signal,
    source: "slash_command",
    status: "active",
    workspaceId: "workspace-1"
  });
});

test("workspace engine host sends public intents and command settlements to the observer", async () => {
  const commands: EngineExternalCommand[] = [];
  const intents: EngineIntent[] = [];
  const host = createWorkspaceAgentSessionEngineHost({
    activityEventObserver: {
      observeCommand: (command) => commands.push(command),
      observeIntent: (intent) => intents.push(intent)
    },
    activateSession: async () => ({}) as never,
    cancelTurn: async () => ({}),
    reconcileSession: async () => ({}),
    restorePendingSessionRecording() {},
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    },
    sendInput: async () => ({ ok: true }),
    submitInteractive: async () => ({}) as never,
    submitPlanDecision: async () => ({}) as never,
    subscribeSessionEvents: () => () => {},
    takePendingSessionRecording: () => null,
    tuttidClient: {} as TuttidClient,
    unactivateSession: async () => ({}) as never,
    updateSessionSettings: async () => ({}) as never,
    updateTuttiModeActivation: async () => ({}) as never,
    workspaceId: "workspace-1"
  });

  host.engine.dispatch({ probeId: "probe-1", type: "engine/probeRequested" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    commands.map((command) => command.type),
    ["engine/probe"]
  );
  assert.deepEqual(
    intents.map((intent) => intent.type),
    ["engine/probeRequested", "engine/commandResult"]
  );
  host.dispose();
});

test("desktop host follows the shared settings-before-send workflow", async () => {
  const operations: string[] = [];
  const updatedSession = session({ browserUse: true, updatedAtUnixMs: 2 });
  const host = createWorkspaceAgentSessionEngineHost({
    activateSession: async () => ({}) as never,
    cancelTurn: async () => ({}),
    reconcileSession: async () => ({}),
    restorePendingSessionRecording() {},
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    },
    sendInput: async () => {
      operations.push("send");
      throw new Error("send rejected");
    },
    submitInteractive: async () => ({}) as never,
    submitPlanDecision: async () => ({}) as never,
    subscribeSessionEvents: () => () => {},
    takePendingSessionRecording: () => null,
    tuttidClient: {} as TuttidClient,
    unactivateSession: async () => ({}) as never,
    updateSessionSettings: async () => {
      operations.push("settings");
      return {
        agentSessionId: "session-1",
        session: updatedSession,
        settings: { browserUse: true }
      };
    },
    updateTuttiModeActivation: async () => ({}) as never,
    workspaceId: "workspace-1"
  });
  host.engine.dispatch({
    sessions: [session({ browserUse: false })],
    type: "session/snapshotReceived"
  });
  host.engine.dispatch({
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ text: "browse", type: "text" }],
    expiresAtUnixMs: 120_000,
    requestedAtUnixMs: 1,
    requiredSettingsPatch: { browserUse: true },
    type: "submit/requested",
    workspaceId: "workspace-1"
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(operations, ["settings", "send"]);
  assert.equal(
    host.engine.getSnapshot().sessionLifecycle.sessionsById["session-1"]
      ?.settings.browserUse,
    true
  );
  host.dispose();
});

test("workspace engine host still executes commands when the command observer fails", async () => {
  const host = createWorkspaceAgentSessionEngineHost({
    activityEventObserver: {
      observeCommand: () => {
        throw new Error("recorder failed");
      },
      observeIntent: () => {}
    },
    activateSession: async () => ({}) as never,
    cancelTurn: async () => ({}),
    reconcileSession: async () => ({}),
    restorePendingSessionRecording() {},
    runtimeApi: {
      logTerminalDiagnostic: async () => {}
    },
    sendInput: async () => ({ ok: true }),
    submitInteractive: async () => ({}) as never,
    submitPlanDecision: async () => ({}) as never,
    subscribeSessionEvents: () => () => {},
    takePendingSessionRecording: () => null,
    tuttidClient: {} as TuttidClient,
    unactivateSession: async () => ({}) as never,
    updateSessionSettings: async () => ({}) as never,
    updateTuttiModeActivation: async () => ({}) as never,
    workspaceId: "workspace-1"
  });

  host.engine.dispatch({ probeId: "probe-1", type: "engine/probeRequested" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    host.engine.getSnapshot().engineRuntime.lastCommandResult?.outcome,
    "succeeded"
  );
  host.dispose();
});

function session(
  overrides: Partial<AgentActivitySession["settings"]> & {
    updatedAtUnixMs?: number;
  }
): AgentActivitySession {
  const { updatedAtUnixMs = 1, ...settings } = overrides;
  return normalizeAgentActivitySession({
    activeTurn: null,
    activeTurnId: null,
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    settings,
    title: "Session",
    updatedAtUnixMs,
    workspaceId: "workspace-1"
  });
}
