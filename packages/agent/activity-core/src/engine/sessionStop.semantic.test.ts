import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { AgentActivityTurn } from "../types.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import {
  selectLatestStopTargetSubmitForSession,
  selectSessionHasPendingSubmitStopTarget
} from "./pendingIntents.selectors.ts";
import { selectEngineCancelState } from "./sessionLifecycle.selectors.ts";
import { createTestEngineCommandPort } from "./testEngineCommandPort.ts";
import type { EngineExternalCommand, EngineScheduler } from "./types.ts";

function createHarness(active: boolean) {
  let nowUnixMs = 100;
  const commands: EngineExternalCommand[] = [];
  const scheduled: Array<{
    canceled: boolean;
    delayMs: number;
  }> = [];
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

test("semantic session stop targets the latest pending prompt admission", () => {
  const harness = createHarness(false);

  assert.deepEqual(
    harness.engine.submitPrompt({
      agentSessionId: "session-1",
      clientSubmitId: "submit-1",
      content: [{ text: "hello", type: "text" }]
    }),
    { accepted: true, queued: false }
  );
  assert.equal(
    selectSessionHasPendingSubmitStopTarget(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    true
  );

  harness.engine.stopSession({ agentSessionId: "session-1" });

  assert.equal(
    selectEngineCancelState(harness.engine.getSnapshot(), "session-1")
      ?.targetClientSubmitId,
    "submit-1"
  );
  assert.equal(harness.commands.at(-1)?.type, "queue/sendPrompt");
});

test("semantic session stop does not target a failed submit admission", () => {
  const harness = createHarness(false);

  harness.engine.submitPrompt({
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ text: "hello", type: "text" }]
  });
  harness.engine.dispatch({
    commandId: "send-1",
    commandType: "queue/sendPrompt",
    correlationId: "submit-1",
    errorCode: "send_failed",
    errorMessage: "send failed",
    outcome: "failed",
    type: "engine/commandResult"
  });

  harness.engine.stopSession({ agentSessionId: "session-1" });

  assert.equal(
    selectEngineCancelState(harness.engine.getSnapshot(), "session-1")
      ?.targetClientSubmitId,
    null
  );
  assert.equal(
    selectEngineCancelState(harness.engine.getSnapshot(), "session-1")?.status,
    "awaitingTurn"
  );
});

test("semantic session stop keeps a delivery-unknown submit as its target", () => {
  const harness = createHarness(false);

  harness.engine.submitPrompt({
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ text: "hello", type: "text" }]
  });
  harness.engine.dispatch({
    commandId: "send-1",
    commandType: "queue/sendPrompt",
    correlationId: "submit-1",
    errorCode: "timeout",
    outcome: "timedOut",
    type: "engine/commandResult"
  });

  harness.engine.stopSession({ agentSessionId: "session-1" });

  assert.equal(
    selectEngineCancelState(harness.engine.getSnapshot(), "session-1")
      ?.targetClientSubmitId,
    "submit-1"
  );
});

test("stop target selection ignores a submit whose canonical Turn is settled", () => {
  const harness = createHarness(false);
  const turn = settledTurn();

  harness.engine.submitPrompt({
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ text: "hello", type: "text" }]
  });
  harness.engine.dispatch({
    commandId: "send-1",
    commandType: "queue/sendPrompt",
    correlationId: "submit-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: { session: session(turn), turn, turnId: turn.turnId }
  });

  assert.equal(
    selectLatestStopTargetSubmitForSession(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    null
  );
  assert.equal(
    selectSessionHasPendingSubmitStopTarget(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    false
  );
});

test("semantic session stop preserves an explicit submit target with an active turn", () => {
  const harness = createHarness(true);

  harness.engine.stopSession({
    agentSessionId: "session-1",
    clientSubmitId: "submit-explicit"
  });

  assert.deepEqual(harness.commands, []);
  assert.equal(
    selectEngineCancelState(harness.engine.getSnapshot(), "session-1")
      ?.targetClientSubmitId,
    "submit-explicit"
  );
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

function settledTurn(): AgentActivityTurn {
  return {
    ...activeTurn(),
    outcome: "completed",
    phase: "settled",
    settledAtUnixMs: 3
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
