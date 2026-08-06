import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { AgentActivityTurn } from "../types.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import { createTestEngineCommandPort } from "./testEngineCommandPort.ts";
import type {
  EngineExternalCommand,
  EngineIntent,
  EngineScheduler
} from "./types.ts";

function createHarness(active: boolean) {
  const commands: EngineExternalCommand[] = [];
  const observedIntents: EngineIntent[] = [];
  const scheduled: Array<{ canceled: boolean; delayMs: number }> = [];
  const commandPort = createTestEngineCommandPort((command) => {
    commands.push(command);
    return new Promise(() => undefined);
  });
  const scheduler: EngineScheduler = {
    schedule(delayMs) {
      const task = { canceled: false, delayMs };
      scheduled.push(task);
      return {
        cancel() {
          task.canceled = true;
        }
      };
    }
  };
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 100 },
    commandPort,
    identity: { origin: "test", workspaceId: "workspace-1" },
    intentObserver: (intent) => {
      observedIntents.push(intent);
    },
    scheduler
  });
  engine.dispatch({
    sessions: [session(active ? activeTurn() : null)],
    type: "session/snapshotReceived"
  });
  return { commands, engine, observedIntents, scheduled };
}

test("semantic prompt submission owns scope, confirmation window, and send projection", () => {
  const harness = createHarness(false);

  const result = harness.engine.submitPrompt({
    agentSessionId: " session-1 ",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: " submit-1 ",
    content: [{ text: "display text", type: "text" }],
    displayPrompt: " Display text ",
    runtimeContent: [{ text: "runtime text", type: "text" }],
    submitDiagnostics: { source: "test" }
  });

  assert.deepEqual(result, { accepted: true, queued: false });
  assert.deepEqual(harness.observedIntents.at(-1), {
    agentSessionId: "session-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-1",
    content: [{ text: "display text", type: "text" }],
    displayPrompt: "Display text",
    expiresAtUnixMs: 120_100,
    requestedAtUnixMs: 100,
    routing: "auto",
    runtimeContent: [{ text: "runtime text", type: "text" }],
    submitDiagnostics: { queued: false, source: "test" },
    type: "submit/requested",
    workspaceId: "workspace-1"
  });
  assert.deepEqual(harness.commands, [
    {
      agentSessionId: "session-1",
      capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
      clientSubmitId: "submit-1",
      commandId: "queue:send:session-1:1",
      content: [{ text: "runtime text", type: "text" }],
      correlationId: "submit-1",
      displayPrompt: "Display text",
      promptId: "submit-1",
      submitDiagnostics: {
        blockCount: 1,
        queued: false,
        source: "test",
        submittedAtUnixMs: 100
      },
      timeoutMs: 90_000,
      type: "queue/sendPrompt",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(
    harness.scheduled.map((task) => task.delayMs),
    [120_000, 90_000]
  );
});

test("semantic prompt submission reports visible queue admission for a busy Session", () => {
  const harness = createHarness(true);

  const result = harness.engine.submitPrompt({
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ text: "continue", type: "text" }],
    submitDiagnostics: { source: "test" }
  });

  assert.deepEqual(result, { accepted: true, queued: true });
  const observed = harness.observedIntents.at(-1);
  assert.equal(observed?.type, "submit/requested");
  assert.equal(
    observed && observed.type === "submit/requested"
      ? observed.submitDiagnostics?.queued
      : undefined,
    true
  );
  assert.deepEqual(harness.commands, []);
  assert.deepEqual(
    harness.scheduled.map((task) => task.delayMs),
    [120_000]
  );
});

test("semantic prompt submission rejects an invalid identity without side effects", () => {
  const harness = createHarness(false);

  const result = harness.engine.submitPrompt({
    agentSessionId: " ",
    clientSubmitId: "submit-1",
    content: [{ text: "continue", type: "text" }]
  });

  assert.deepEqual(result, { accepted: false, queued: false });
  assert.deepEqual(harness.commands, []);
  assert.deepEqual(harness.scheduled, []);
});

function activeTurn(): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    origin: "user_prompt",
    phase: "running",
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 2
  };
}

function session(turn: AgentActivityTurn | null) {
  return normalizeAgentActivitySession({
    activeTurn: turn,
    activeTurnId: turn?.turnId ?? null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    latestTurn: turn,
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: "Session",
    workspaceId: "workspace-1"
  });
}
