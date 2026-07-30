import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { AgentActivityTurn } from "../types.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import { selectEngineCancelState } from "./sessionLifecycle.selectors.ts";
import type {
  EngineCommandPort,
  EngineExternalCommand,
  EngineScheduler
} from "./types.ts";

function createHarness(active: boolean) {
  let nowUnixMs = 100;
  const commands: EngineExternalCommand[] = [];
  const scheduled: Array<{
    canceled: boolean;
    delayMs: number;
  }> = [];
  const commandPort: EngineCommandPort = {
    execute(command) {
      commands.push(command);
      return new Promise(() => undefined);
    }
  };
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
    clock: { nowUnixMs: () => nowUnixMs },
    commandPort,
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler
  });
  engine.dispatch({
    sessions: [session(active ? activeTurn() : null)],
    type: "session/snapshotReceived"
  });
  return {
    commands,
    engine,
    scheduled,
    setNow(value: number) {
      nowUnixMs = value;
    }
  };
}

test("semantic session stop owns command identity, scope, and timeout", () => {
  const harness = createHarness(true);

  harness.engine.stopSession({ agentSessionId: " session-1 " });

  assert.deepEqual(harness.commands, [
    {
      agentSessionId: "session-1",
      commandId: "stop:100:1",
      timeoutMs: 30_000,
      turnId: "turn-1",
      type: "turn/cancel",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    selectEngineCancelState(harness.engine.getSnapshot(), "session-1")?.status,
    "requested"
  );
});

test("semantic session stop waits 30 seconds for a first Turn and deduplicates repeated requests", () => {
  const harness = createHarness(false);

  harness.engine.stopSession({ agentSessionId: "session-1" });
  harness.engine.stopSession({ agentSessionId: "session-1" });

  assert.deepEqual(harness.commands, []);
  assert.deepEqual(harness.scheduled, [
    {
      canceled: false,
      delayMs: 30_000
    }
  ]);
  assert.equal(
    selectEngineCancelState(harness.engine.getSnapshot(), "session-1")?.status,
    "awaitingTurn"
  );

  harness.setNow(200);
  harness.engine.dispatch({
    session: session(activeTurn()),
    type: "session/upserted"
  });

  assert.deepEqual(harness.commands, [
    {
      agentSessionId: "session-1",
      commandId: "stop:100:1",
      timeoutMs: 30_000,
      turnId: "turn-1",
      type: "turn/cancel",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(harness.scheduled[0]?.canceled, true);
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
