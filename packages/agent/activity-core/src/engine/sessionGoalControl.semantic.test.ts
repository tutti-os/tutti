import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { AgentActivityGoalControlResult } from "../types.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import { createTestEngineCommandPort } from "./testEngineCommandPort.ts";
import { selectEngineSession } from "./sessionLifecycle.selectors.ts";
import {
  selectSessionGoalControlPresentation,
  selectSessionGoalControlSettlement
} from "./sessionGoalControl.selectors.ts";
import type { AgentSessionGoalControlEffectInput } from "./sessionGoalControl.types.ts";
import type {
  AgentSessionEffectPort,
  EngineExtensionCommand,
  EngineScheduler,
  EngineTypedCommandPort
} from "./types.ts";

function createHarness(initialGoal = goal("existing goal", "active")) {
  let nowUnixMs = 100;
  let sequence = 0;
  const calls: AgentSessionGoalControlEffectInput[] = [];
  const extensions: EngineExtensionCommand[] = [];
  const settlers: Array<{
    reject(error: unknown): void;
    resolve(result: AgentActivityGoalControlResult): void;
  }> = [];
  const tasks: Array<{
    atUnixMs: number;
    canceled: boolean;
    run(): void;
    sequence: number;
  }> = [];
  const effects = {
    controlGoal(input: AgentSessionGoalControlEffectInput) {
      calls.push(input);
      return new Promise<AgentActivityGoalControlResult>((resolve, reject) => {
        settlers.push({ reject, resolve });
      });
    }
  } as AgentSessionEffectPort;
  const commandPort: EngineTypedCommandPort = {
    effects,
    execute(command) {
      extensions.push(command);
      return new Promise(() => undefined);
    },
    kind: "typed"
  };
  const scheduler: EngineScheduler = {
    schedule(delayMs, run) {
      const task = {
        atUnixMs: nowUnixMs + delayMs,
        canceled: false,
        run,
        sequence: sequence++
      };
      tasks.push(task);
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
    session: session(initialGoal, 1),
    type: "session/upserted"
  });
  return {
    advance(ms: number) {
      nowUnixMs += ms;
      for (;;) {
        const due = tasks
          .filter((task) => !task.canceled && task.atUnixMs <= nowUnixMs)
          .sort(
            (left, right) =>
              left.atUnixMs - right.atUnixMs || left.sequence - right.sequence
          )[0];
        if (!due) return;
        due.canceled = true;
        due.run();
      }
    },
    calls,
    engine,
    extensions,
    reject(index: number, error: unknown) {
      settlers[index]?.reject(error);
    },
    resolve(
      index: number,
      resultGoal: ReturnType<typeof goal> | null,
      updatedAtUnixMs = 2,
      sessionGoal = resultGoal
    ) {
      settlers[index]?.resolve({
        goal: resultGoal,
        operationId: `operation-${index + 1}`,
        session: session(sessionGoal, updatedAtUnixMs),
        state: {
          desired: resultGoal,
          lastEvidence: { source: "test" },
          observed: resultGoal,
          pendingOperationId: null,
          revision: index + 1,
          syncStatus: "synced",
          tombstoned: resultGoal === null,
          updatedAtUnixMs
        }
      });
    },
    resolveApplying(
      index: number,
      desiredGoal: ReturnType<typeof goal> | null
    ) {
      settlers[index]?.resolve({
        goal: desiredGoal,
        operationId: `operation-${index + 1}`,
        session: session(initialGoal, 2),
        state: {
          desired: desiredGoal,
          lastEvidence: { source: "accepted-test" },
          observed: initialGoal,
          pendingOperationId: `operation-${index + 1}`,
          revision: index + 1,
          syncStatus: "applying",
          tombstoned: desiredGoal === null,
          updatedAtUnixMs: 2
        }
      });
    }
  };
}

test("semantic Goal Control owns admission, identity, and optimistic projection", () => {
  const harness = createHarness();

  const accepted = harness.engine.controlGoal({
    action: "set",
    agentSessionId: " session-1 ",
    clientSubmitId: " goal-submit-1 ",
    objective: " ship it "
  });

  assert.deepEqual(accepted, {
    accepted: true,
    clientSubmitId: "goal-submit-1"
  });
  assert.deepEqual(harness.calls, [
    {
      action: "set",
      agentSessionId: "session-1",
      clientSubmitId: "goal-submit-1",
      objective: "ship it",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    "operationsBySessionId" in harness.engine.getSnapshot().goalControl,
    false
  );
  assert.deepEqual(
    selectSessionGoalControlPresentation(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    {
      agentSessionId: "session-1",
      goal: goal("ship it", "active"),
      optimistic: true,
      status: "pending"
    }
  );
  assert.equal(
    harness.engine.controlGoal({
      action: "pause",
      agentSessionId: "session-1",
      clientSubmitId: "goal-submit-2"
    }).accepted,
    false
  );
  assert.equal(harness.calls.length, 1);
});

test("typed Goal Control success updates canonical Session and operation evidence", async () => {
  const harness = createHarness();
  harness.engine.controlGoal({
    action: "set",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-1",
    objective: "ship it"
  });

  harness.resolve(0, goal("ship it", "active"));
  await flushMicrotasks();

  const settlement = selectSessionGoalControlSettlement(
    harness.engine.getSnapshot(),
    "session-1"
  );
  assert.equal(settlement?.status, "succeeded");
  assert.equal(settlement?.clientSubmitId, "goal-submit-1");
  assert.deepEqual(
    selectSessionGoalControlPresentation(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    {
      agentSessionId: "session-1",
      goal: goal("ship it", "active"),
      optimistic: false,
      status: "succeeded"
    }
  );
});

test("a Session without Goal state does not rebuild another Session Goal projection", () => {
  const harness = createHarness();
  const initialGoalControl = harness.engine.getSnapshot().goalControl;

  harness.engine.dispatch({
    session: {
      ...session(null, 2),
      agentSessionId: "session-without-goal"
    },
    type: "session/upserted"
  });

  const afterUnrelatedInsert = harness.engine.getSnapshot().goalControl;
  assert.equal(afterUnrelatedInsert, initialGoalControl);
  assert.equal(
    afterUnrelatedInsert.presentationsBySessionId["session-without-goal"],
    undefined
  );
  assert.deepEqual(
    selectSessionGoalControlPresentation(
      harness.engine.getSnapshot(),
      "session-without-goal"
    ),
    {
      agentSessionId: "session-without-goal",
      goal: null,
      optimistic: false,
      status: "idle"
    }
  );

  harness.engine.dispatch({
    turn: {
      agentSessionId: "session-without-goal",
      origin: "user_prompt",
      phase: "running",
      startedAtUnixMs: 2,
      turnId: "turn-1",
      updatedAtUnixMs: 2
    },
    live: true,
    type: "turn/upserted"
  });

  assert.equal(harness.engine.getSnapshot().goalControl, initialGoalControl);

  harness.engine.dispatch({
    agentSessionId: "session-without-goal",
    patch: { title: "Updated unrelated Session", updatedAtUnixMs: 3 },
    type: "session/metadataPatched"
  });

  assert.equal(harness.engine.getSnapshot().goalControl, initialGoalControl);
  assert.equal(
    harness.engine.getSnapshot().goalControl.presentationsBySessionId[
      "session-1"
    ],
    initialGoalControl.presentationsBySessionId["session-1"]
  );
});

test("explicit Goal clear overrides a stale runtime Session projection", async () => {
  const existingGoal = goal("existing goal", "active");
  const harness = createHarness(existingGoal);
  harness.engine.controlGoal({
    action: "clear",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-1"
  });

  harness.resolve(0, null, 2, existingGoal);
  await flushMicrotasks();

  assert.deepEqual(
    selectSessionGoalControlPresentation(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    {
      agentSessionId: "session-1",
      goal: null,
      optimistic: false,
      status: "succeeded"
    }
  );
  assert.equal(
    harness.engine.getSnapshot().sessionLifecycle.sessionsById["session-1"]
      ?.goal,
    null
  );
});

test("Goal clear wins over a newer mid-flight Session version bump", async () => {
  const existingGoal = goal("existing goal", "active");
  const harness = createHarness(existingGoal);
  // Simulate turn/session bumps that advance updatedAtUnixMs while clear RPC
  // is in flight; the clear response Session itself stays on an older version.
  harness.engine.dispatch({
    session: session(existingGoal, 9_000),
    type: "session/upserted"
  });
  harness.engine.controlGoal({
    action: "clear",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-1"
  });

  harness.resolve(0, null, 2, existingGoal);
  await flushMicrotasks();

  assert.equal(
    harness.engine.getSnapshot().sessionLifecycle.sessionsById["session-1"]
      ?.goal,
    null
  );
  assert.deepEqual(
    selectSessionGoalControlPresentation(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    {
      agentSessionId: "session-1",
      goal: null,
      optimistic: false,
      status: "succeeded"
    }
  );
});

test("timeout remains delivery-unknown and an exact retry reuses Host identity", () => {
  const harness = createHarness();
  harness.engine.controlGoal({
    action: "clear",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-1"
  });

  harness.advance(30_000);

  assert.equal(
    selectSessionGoalControlSettlement(
      harness.engine.getSnapshot(),
      "session-1"
    )?.status,
    "unknown"
  );
  assert.equal(harness.extensions.length, 0);

  harness.engine.dispatch({
    session: session(null, 3),
    type: "session/upserted"
  });

  assert.equal(
    selectSessionGoalControlSettlement(
      harness.engine.getSnapshot(),
      "session-1"
    )?.status,
    "unknown"
  );
  assert.deepEqual(
    harness.engine.controlGoal({
      action: "clear",
      agentSessionId: "session-1",
      clientSubmitId: "new-ui-identity"
    }),
    { accepted: true, clientSubmitId: "goal-submit-1" }
  );
  assert.equal(harness.calls[1]?.clientSubmitId, "goal-submit-1");
});

test("a same-looking Goal action still crosses the Host lifecycle boundary", () => {
  const harness = createHarness();

  const accepted = harness.engine.controlGoal({
    action: "resume",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-1"
  });

  assert.equal(accepted.accepted, true);
  assert.equal(harness.calls.length, 1);
  assert.equal(
    selectSessionGoalControlSettlement(
      harness.engine.getSnapshot(),
      "session-1"
    )?.status,
    "pending"
  );
});

test("provider-accepted Goal state is valid before Session projection converges", async () => {
  const harness = createHarness();
  harness.engine.controlGoal({
    action: "set",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-1",
    objective: "ship it"
  });

  harness.resolveApplying(0, goal("ship it", "active"));
  await flushMicrotasks();

  const settlement = selectSessionGoalControlSettlement(
    harness.engine.getSnapshot(),
    "session-1"
  );
  assert.equal(settlement?.status, "accepted");
  assert.equal(settlement?.clientSubmitId, "goal-submit-1");
  assert.deepEqual(
    selectSessionGoalControlPresentation(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    {
      agentSessionId: "session-1",
      goal: goal("ship it", "active"),
      optimistic: false,
      status: "accepted"
    }
  );
  assert.deepEqual(
    harness.engine.getSnapshot().sessionLifecycle.sessionsById["session-1"]
      ?.goal,
    goal("existing goal", "active")
  );
});

test("accepted set yields to a later canonical terminal Goal observation", async () => {
  const harness = createHarness();
  harness.engine.controlGoal({
    action: "set",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-1",
    objective: "ship it"
  });
  harness.resolveApplying(0, goal("ship it", "active"));
  await flushMicrotasks();

  harness.engine.dispatch({
    session: session(goal("ship it", "complete"), 200),
    type: "session/upserted"
  });

  assert.deepEqual(
    selectSessionGoalControlPresentation(
      harness.engine.getSnapshot(),
      "session-1"
    ),
    {
      agentSessionId: "session-1",
      goal: goal("ship it", "complete"),
      optimistic: false,
      status: "accepted"
    }
  );
});

test("uncertain rejection stays retryable while pre-admission rejection fails", async () => {
  const uncertain = createHarness();
  uncertain.engine.controlGoal({
    action: "clear",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-1"
  });
  uncertain.reject(0, new Error("response lost"));
  await flushMicrotasks();
  assert.equal(
    selectSessionGoalControlSettlement(
      uncertain.engine.getSnapshot(),
      "session-1"
    )?.status,
    "unknown"
  );

  const definitive = createHarness();
  definitive.engine.controlGoal({
    action: "clear",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-2"
  });
  definitive.reject(
    0,
    Object.assign(new Error("invalid goal"), { code: "invalid_request" })
  );
  await flushMicrotasks();
  assert.equal(
    selectSessionGoalControlSettlement(
      definitive.engine.getSnapshot(),
      "session-1"
    )?.status,
    "failed"
  );
});

test("new-session Goal projection yields to canonical hydration and later Goal control", async () => {
  const replacementGoal = goal("replacement goal", "active");
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 100 },
    commandPort: createTestEngineCommandPort((command) => {
      if (command.type !== "goal/control") {
        return new Promise(() => undefined);
      }
      return Promise.resolve({
        goal: replacementGoal,
        operationId: "replacement-operation",
        session: {
          ...session(replacementGoal, 3),
          agentSessionId: "session-new",
          goalSyncState: {
            pendingOperationId: null,
            revision: 2,
            syncStatus: "synced"
          }
        },
        state: {
          desired: replacementGoal,
          lastEvidence: { source: "test" },
          observed: replacementGoal,
          pendingOperationId: null,
          revision: 2,
          syncStatus: "synced",
          tombstoned: false,
          updatedAtUnixMs: 3
        }
      });
    }),
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler: { schedule: () => ({ cancel() {} }) }
  });
  engine.activateSession({
    agentSessionId: "session-new",
    agentTargetId: "target-1",
    clientSubmitId: "activation-submit-1",
    initialGoalControl: { action: "set", objective: "ship it" },
    mode: "new",
    requestId: "activation-1"
  });

  assert.deepEqual(
    selectSessionGoalControlPresentation(engine.getSnapshot(), "session-new"),
    {
      agentSessionId: "session-new",
      goal: goal("ship it", "active"),
      optimistic: true,
      status: "pending_create"
    }
  );

  engine.dispatch({
    session: {
      ...session(goal("ship it", "active"), 2),
      agentSessionId: "session-new",
      goalSyncState: {
        pendingOperationId: "goal-operation-1",
        revision: 1,
        syncStatus: "applying"
      }
    },
    type: "session/upserted"
  });

  assert.deepEqual(
    selectSessionGoalControlPresentation(engine.getSnapshot(), "session-new"),
    {
      agentSessionId: "session-new",
      goal: goal("ship it", "active"),
      optimistic: false,
      status: "idle"
    }
  );
  assert.deepEqual(
    selectEngineSession(engine.getSnapshot(), "session-new")?.goalSyncState,
    {
      executionPending: false,
      pendingOperationId: "goal-operation-1",
      revision: 1,
      syncStatus: "applying"
    }
  );

  engine.dispatch({
    session: {
      ...session(goal("ship it", "active"), 2),
      agentSessionId: "session-new"
    },
    type: "session/upserted"
  });
  assert.deepEqual(
    selectEngineSession(engine.getSnapshot(), "session-new")?.goalSyncState,
    {
      executionPending: false,
      pendingOperationId: "goal-operation-1",
      revision: 1,
      syncStatus: "applying"
    }
  );

  assert.deepEqual(
    engine.controlGoal({
      action: "set",
      agentSessionId: "session-new",
      clientSubmitId: "replacement-submit",
      objective: replacementGoal.objective
    }),
    { accepted: true, clientSubmitId: "replacement-submit" }
  );
  await flushMicrotasks();

  assert.deepEqual(
    selectSessionGoalControlPresentation(engine.getSnapshot(), "session-new"),
    {
      agentSessionId: "session-new",
      goal: replacementGoal,
      optimistic: false,
      status: "succeeded"
    }
  );
});

function goal(
  objective: string,
  status: "active" | "paused" | "complete"
): {
  objective: string;
  status: "active" | "paused" | "complete";
} {
  return { objective, status };
}

function session(
  sessionGoal: ReturnType<typeof goal> | null,
  updatedAtUnixMs: number
) {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    goal: sessionGoal,
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: "Session",
    updatedAtUnixMs,
    workspaceId: "workspace-1"
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
