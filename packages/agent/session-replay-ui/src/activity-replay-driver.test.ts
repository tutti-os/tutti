import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentSessionEngine,
  EngineExternalCommand,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import type { AgentSessionActivityEvent } from "./activity-event.ts";
import {
  installAgentSessionActivityReplayDriver,
  rebaseReplayIntentPayload,
  type AgentSessionActivityReplayDriver
} from "./activity-replay-driver.ts";

const defaultCassetteID = "cassette-default";

test("dispatches through an explicitly registered Cassette", () => {
  const intents: EngineIntent[] = [];
  const driver = installDriver(intents);

  driver.dispatchCassetteIntent(
    defaultCassetteID,
    activityEvent({
      agentSessionId: "session-1",
      correlationId: "submit-1",
      kind: "intent",
      payload: {
        clientSubmitId: "submit-1",
        content: [{ text: "continue", type: "text" }],
        requestedAtUnixMs: 100
      },
      type: "submit/requested"
    })
  );

  assert.equal(replayGlobal().__tuttiAgentSessionReplayDriver, driver);
  assert.deepEqual(intents, [
    {
      agentSessionId: "session-1",
      clientSubmitId: "submit-1",
      content: [{ text: "continue", type: "text" }],
      requestedAtUnixMs: 100,
      type: "submit/requested",
      workspaceId: "workspace-1"
    }
  ]);
  driver.dispose();
});

test("materializes cassette-scoped command IDs for correlation-only stop intents", async () => {
  const intents: EngineIntent[] = [];
  const driver = installDriver(intents);
  const stopIntent = activityEvent({
    agentSessionId: "session-1",
    correlationId: "stop-1",
    eventId: "stop-event-1",
    kind: "intent",
    payload: {
      awaitingTurnExpiresAtUnixMs: 6_000,
      timeoutMs: 30_000
    },
    type: "session/stopRequested"
  });

  driver.dispatchCassetteIntent(defaultCassetteID, stopIntent);
  const dispatched = intents[0];
  assert.equal(dispatched?.type, "session/stopRequested");
  assert.equal(
    typeof (dispatched?.type === "session/stopRequested"
      ? dispatched.awaitingTurnExpiresAtUnixMs
      : undefined),
    "number"
  );
  assert.deepEqual(
    dispatched?.type === "session/stopRequested"
      ? { ...dispatched, awaitingTurnExpiresAtUnixMs: undefined }
      : null,
    {
      agentSessionId: "session-1",
      awaitingTurnExpiresAtUnixMs: undefined,
      commandId: "replay:cassette-default:stop-event-1",
      timeoutMs: 30_000,
      type: "session/stopRequested",
      workspaceId: "workspace-1"
    }
  );

  driver.observeCommand({
    agentSessionId: "session-1",
    commandId: "replay:cassette-default:stop-event-1",
    turnId: "replayed-turn-1",
    type: "turn/cancel",
    workspaceId: "workspace-1"
  });
  const verification = driver.verifyCassetteEffect(
    defaultCassetteID,
    activityEvent({
      agentSessionId: "session-1",
      correlationId: "stop-1",
      kind: "effect",
      payload: { outcome: "succeeded", turnId: "recorded-turn-1" },
      type: "turn/cancel"
    })
  );
  driver.observeIntent(
    commandResult({
      commandId: "replay:cassette-default:stop-event-1",
      commandType: "turn/cancel",
      outcome: "succeeded"
    })
  );
  await verification;
  driver.dispose();
});

test("requires matching turn IDs for an uncorrelated cancel", async () => {
  const driver = installDriver([], 5);
  driver.observeCommand({
    agentSessionId: "session-1",
    commandId: "uncorrelated-cancel-1",
    turnId: "replayed-turn-1",
    type: "turn/cancel",
    workspaceId: "workspace-1"
  });
  driver.observeIntent(
    commandResult({
      commandId: "uncorrelated-cancel-1",
      commandType: "turn/cancel",
      outcome: "succeeded"
    })
  );

  await assert.rejects(
    driver.verifyCassetteEffect(
      defaultCassetteID,
      activityEvent({
        agentSessionId: "session-1",
        kind: "effect",
        payload: { outcome: "succeeded", turnId: "recorded-turn-1" },
        type: "turn/cancel"
      })
    ),
    /timed out waiting for renderer effect turn\/cancel; commandId=<unmatched>/
  );
  driver.dispose();
});

test("binds the send-now cancel effect through the recorded cancelCommandId", async () => {
  const intents: EngineIntent[] = [];
  const driver = installDriver(intents);

  driver.dispatchCassetteIntent(
    defaultCassetteID,
    activityEvent({
      agentSessionId: "session-1",
      correlationId: "prompt-1",
      eventId: "send-now-event-1",
      kind: "intent",
      payload: {
        awaitingTurnExpiresAtUnixMs: 6_000,
        cancelCommandId: "send-now-cancel-1",
        promptId: "prompt-1",
        timeoutMs: 30_000
      },
      type: "queue/sendNowRequested"
    })
  );
  assert.equal(intents[0]?.type, "queue/sendNowRequested");

  driver.observeCommand({
    agentSessionId: "session-1",
    commandId: "send-now-cancel-1",
    turnId: "turn-1",
    type: "turn/cancel",
    workspaceId: "workspace-1"
  });
  const verification = driver.verifyCassetteEffect(
    defaultCassetteID,
    activityEvent({
      agentSessionId: "session-1",
      correlationId: "prompt-1",
      kind: "effect",
      payload: { outcome: "succeeded", turnId: "turn-1" },
      type: "turn/cancel"
    })
  );
  driver.observeIntent(
    commandResult({
      commandId: "send-now-cancel-1",
      commandType: "turn/cancel",
      outcome: "succeeded"
    })
  );
  await verification;
  driver.dispose();
});

test("binds the send_now submit cancel effect through the derived commandId", async () => {
  const intents: EngineIntent[] = [];
  const driver = installDriver(intents);

  driver.dispatchCassetteIntent(
    defaultCassetteID,
    activityEvent({
      agentSessionId: "session-1",
      correlationId: "submit-1",
      eventId: "submit-event-1",
      kind: "intent",
      payload: {
        clientSubmitId: "submit-1",
        content: [{ text: "now", type: "text" }],
        expiresAtUnixMs: 5_000,
        requestedAtUnixMs: 90,
        routing: "send_now"
      },
      type: "submit/requested"
    })
  );

  driver.observeCommand({
    agentSessionId: "session-1",
    commandId: "submit:cancel:submit-1",
    turnId: "turn-1",
    type: "turn/cancel",
    workspaceId: "workspace-1"
  });
  const verification = driver.verifyCassetteEffect(
    defaultCassetteID,
    activityEvent({
      agentSessionId: "session-1",
      correlationId: "submit-1",
      kind: "effect",
      payload: { outcome: "succeeded", turnId: "turn-1" },
      type: "turn/cancel"
    })
  );
  driver.observeIntent(
    commandResult({
      commandId: "submit:cancel:submit-1",
      commandType: "turn/cancel",
      outcome: "succeeded"
    })
  );
  await verification;
  driver.dispose();
});

test("rejects the wrong event kind, scope, and reserved payload fields", () => {
  const driver = installDriver([]);

  assert.throws(
    () =>
      driver.dispatchCassetteIntent(
        defaultCassetteID,
        activityEvent({
          kind: "effect",
          payload: {},
          type: "submit/requested"
        })
      ),
    /kind mismatch: expected intent, got effect/
  );
  assert.throws(
    () =>
      driver.dispatchCassetteIntent(
        defaultCassetteID,
        activityEvent({
          kind: "intent",
          payload: {},
          scopeId: "workspace-2",
          type: "submit/requested"
        })
      ),
    /scope mismatch: expected workspace-1, got workspace-2/
  );
  assert.throws(
    () =>
      driver.dispatchCassetteIntent(
        defaultCassetteID,
        activityEvent({
          kind: "intent",
          payload: { workspaceId: "workspace-2" },
          type: "submit/requested"
        })
      ),
    /payload must not contain workspaceId/
  );
  driver.dispose();
});

test("rebases recorded activation, submit, feedback, cancel, and stop expiry", () => {
  for (const type of [
    "activation/requested",
    "submit/requested",
    "plan/feedbackRequested"
  ]) {
    const event = activityEvent({
      kind: "intent",
      payload: {
        expiresAtUnixMs: 125_000,
        requestedAtUnixMs: 5_000
      },
      type
    });

    assert.deepEqual(rebaseReplayIntentPayload(event, 900_000), {
      expiresAtUnixMs: 1_020_000,
      requestedAtUnixMs: 900_000
    });
    assert.deepEqual(event.payload, {
      expiresAtUnixMs: 125_000,
      requestedAtUnixMs: 5_000
    });
  }
  for (const type of ["session/cancelRequested", "session/stopRequested"]) {
    assert.deepEqual(
      rebaseReplayIntentPayload(
        activityEvent({
          kind: "intent",
          occurredAtUnixMs: 1_000,
          payload: { awaitingTurnExpiresAtUnixMs: 6_000 },
          type
        }),
        10_000
      ),
      { awaitingTurnExpiresAtUnixMs: 15_000 }
    );
  }
});

test("waits for canonical lifecycle intent readiness", async () => {
  type Snapshot = ReturnType<AgentSessionEngine["getSnapshot"]>;
  let snapshot = {
    sessionLifecycle: {
      interactionsById: {},
      sessionsById: {},
      turnsById: {}
    }
  } as unknown as Snapshot;
  let listener: ((value: Snapshot) => void) | null = null;
  const driver = installAgentSessionActivityReplayDriver({
    effectTimeoutMs: 100,
    engine: {
      dispatch() {},
      getSnapshot() {
        return snapshot;
      },
      identity: { origin: "test", workspaceId: "workspace-1" },
      subscribe(next) {
        listener = next;
        return () => {
          listener = null;
        };
      }
    }
  });
  driver.registerCassette({
    agentSessionIds: ["session-1", "session-existing"],
    cassetteId: defaultCassetteID
  });
  const event = activityEvent({
    agentSessionId: "session-1",
    kind: "intent",
    payload: { turnId: "turn-1" },
    type: "plan/decisionRequested"
  });

  let ready = false;
  const waiting = driver.waitUntilCassetteIntentReady!(
    defaultCassetteID,
    event
  ).then(() => {
    ready = true;
  });
  await Promise.resolve();
  assert.equal(ready, false);

  snapshot = {
    sessionLifecycle: {
      interactionsById: {},
      sessionsById: {
        "session-1": { workspaceId: "workspace-1" }
      },
      turnsById: {
        "9:session-1turn-1": {
          outcome: "completed",
          phase: "settled"
        }
      }
    }
  } as unknown as Snapshot;
  const notify = listener as ((value: Snapshot) => void) | null;
  assert.ok(notify);
  notify(snapshot);
  await waiting;
  assert.equal(ready, true);

  const existingActivation = activityEvent({
    agentSessionId: "session-existing",
    kind: "intent",
    payload: { mode: "existing", requestId: "activate-existing" },
    type: "activation/requested"
  });
  let existingReady = false;
  const existingWaiting = driver.waitUntilCassetteIntentReady!(
    defaultCassetteID,
    existingActivation
  ).then(() => {
    existingReady = true;
  });
  await Promise.resolve();
  assert.equal(existingReady, false);
  snapshot = {
    sessionLifecycle: {
      interactionsById: {},
      sessionsById: {
        "session-existing": { workspaceId: "workspace-1" }
      },
      turnsById: {}
    }
  } as unknown as Snapshot;
  const notifyExisting = listener as ((value: Snapshot) => void) | null;
  assert.ok(notifyExisting);
  notifyExisting(snapshot);
  await existingWaiting;
  assert.equal(existingReady, true);

  const goalEvent = activityEvent({
    agentSessionId: "session-existing",
    kind: "intent",
    payload: { action: "pause", clientSubmitId: "goal-submit-2" },
    type: "goal/controlRequested"
  });
  snapshot = {
    goalControl: {
      presentationsBySessionId: {
        "session-existing": { status: "unknown" }
      }
    },
    sessionLifecycle: {
      interactionsById: {},
      operationBySessionId: {
        "session-existing": {
          goalControl: { status: "unknown" },
          runtimeAvailability: { state: "available" }
        }
      },
      sessionsById: {
        "session-existing": { workspaceId: "workspace-1" }
      },
      turnsById: {}
    }
  } as unknown as Snapshot;
  let goalReady = false;
  const goalWaiting = driver.waitUntilCassetteIntentReady!(
    defaultCassetteID,
    goalEvent
  ).then(() => {
    goalReady = true;
  });
  await Promise.resolve();
  assert.equal(goalReady, false);
  snapshot = {
    goalControl: {
      presentationsBySessionId: {
        "session-existing": { status: "failed" }
      }
    },
    sessionLifecycle: {
      interactionsById: {},
      operationBySessionId: {
        "session-existing": {
          goalControl: { status: "failed" },
          runtimeAvailability: { state: "available" }
        }
      },
      sessionsById: {
        "session-existing": { workspaceId: "workspace-1" }
      },
      turnsById: {}
    }
  } as unknown as Snapshot;
  const notifyGoal = listener as ((value: Snapshot) => void) | null;
  assert.ok(notifyGoal);
  notifyGoal(snapshot);
  await goalWaiting;
  assert.equal(goalReady, true);

  const interactionEvent = activityEvent({
    agentSessionId: "session-existing",
    kind: "intent",
    payload: {
      action: "approve",
      requestId: "request-1",
      turnId: "turn-1"
    },
    type: "interaction/responseRequested"
  });
  let interactionReady = false;
  const interactionWaiting = driver.waitUntilCassetteIntentReady!(
    defaultCassetteID,
    interactionEvent
  ).then(() => {
    interactionReady = true;
  });
  await Promise.resolve();
  assert.equal(interactionReady, false);
  snapshot = {
    sessionLifecycle: {
      interactionsById: {
        "16:session-existing6:turn-1request-1": {
          status: "pending",
          turnId: "turn-1"
        }
      },
      sessionsById: {
        "session-existing": { workspaceId: "workspace-1" }
      },
      turnsById: {
        "16:session-existingturn-1": {
          phase: "active"
        }
      }
    }
  } as unknown as Snapshot;
  const notifyInteraction = listener as ((value: Snapshot) => void) | null;
  assert.ok(notifyInteraction);
  notifyInteraction(snapshot);
  await interactionWaiting;
  assert.equal(interactionReady, true);

  const cancelEvent = activityEvent({
    agentSessionId: "session-existing",
    kind: "intent",
    payload: { turnId: "turn-1" },
    type: "session/stopRequested"
  });
  snapshot = {
    sessionLifecycle: {
      interactionsById: {},
      sessionsById: {
        "session-existing": {
          activeTurnId: "turn-1",
          agentSessionId: "session-existing",
          workspaceId: "workspace-1"
        }
      },
      turnsById: {
        "16:session-existingturn-1": {
          phase: "settled"
        }
      }
    }
  } as unknown as Snapshot;
  let cancelReady = false;
  const cancelWaiting = driver.waitUntilCassetteIntentReady!(
    defaultCassetteID,
    cancelEvent
  ).then(() => {
    cancelReady = true;
  });
  await Promise.resolve();
  assert.equal(cancelReady, false);
  snapshot = {
    sessionLifecycle: {
      interactionsById: {},
      sessionsById: {
        "session-existing": {
          activeTurnId: "turn-1",
          agentSessionId: "session-existing",
          workspaceId: "workspace-1"
        }
      },
      turnsById: {
        "16:session-existingturn-1": {
          phase: "active"
        }
      }
    }
  } as unknown as Snapshot;
  const notifyCancel = listener as ((value: Snapshot) => void) | null;
  assert.ok(notifyCancel);
  notifyCancel(snapshot);
  await cancelWaiting;
  assert.equal(cancelReady, true);
  driver.dispose();
});

test("claims a canonical child Session through its registered root", () => {
  type Snapshot = ReturnType<AgentSessionEngine["getSnapshot"]>;
  const intents: EngineIntent[] = [];
  const driver = installAgentSessionActivityReplayDriver({
    engine: {
      dispatch(intent) {
        intents.push(intent);
      },
      getSnapshot() {
        return {
          sessionLifecycle: {
            sessionsById: {
              "child-1": {
                agentSessionId: "child-1",
                kind: "child",
                rootAgentSessionId: "root-1",
                workspaceId: "workspace-1"
              }
            }
          }
        } as unknown as Snapshot;
      },
      identity: { origin: "test", workspaceId: "workspace-1" }
    }
  });
  driver.registerCassette({
    agentSessionIds: ["root-1"],
    cassetteId: defaultCassetteID
  });

  driver.dispatchCassetteIntent(
    defaultCassetteID,
    activityEvent({
      agentSessionId: "child-1",
      correlationId: "child-submit-1",
      kind: "intent",
      payload: {
        clientSubmitId: "child-submit-1",
        content: [{ text: "continue", type: "text" }],
        requestedAtUnixMs: 100
      },
      type: "submit/requested"
    })
  );

  const dispatched = intents[0];
  if (!dispatched || dispatched.type !== "submit/requested") {
    assert.fail(`unexpected replay intent ${dispatched?.type ?? "missing"}`);
  }
  assert.equal(dispatched.agentSessionId, "child-1");
  driver.dispose();
});

test("waits for a canonical child Session projection before claiming it", async () => {
  type Snapshot = ReturnType<AgentSessionEngine["getSnapshot"]>;
  const intents: EngineIntent[] = [];
  let snapshot = {
    sessionLifecycle: { sessionsById: {} }
  } as unknown as Snapshot;
  let listener: ((value: Snapshot) => void) | null = null;
  const driver = installAgentSessionActivityReplayDriver({
    engine: {
      dispatch(intent) {
        intents.push(intent);
      },
      getSnapshot() {
        return snapshot;
      },
      identity: { origin: "test", workspaceId: "workspace-1" },
      subscribe(nextListener) {
        listener = nextListener;
        return () => {
          listener = null;
        };
      }
    }
  });
  driver.registerCassette({
    agentSessionIds: ["root-1"],
    cassetteId: defaultCassetteID
  });
  const event = activityEvent({
    agentSessionId: "child-1",
    correlationId: "child-submit-1",
    kind: "intent",
    payload: {
      clientSubmitId: "child-submit-1",
      content: [{ text: "continue", type: "text" }],
      requestedAtUnixMs: 100
    },
    type: "submit/requested"
  });

  let ready = false;
  const waiting = driver.waitUntilCassetteIntentReady!(
    defaultCassetteID,
    event
  ).then(() => {
    ready = true;
  });
  await Promise.resolve();
  assert.equal(ready, false);

  snapshot = {
    sessionLifecycle: {
      sessionsById: {
        "child-1": {
          agentSessionId: "child-1",
          kind: "child",
          rootAgentSessionId: "root-1",
          workspaceId: "workspace-1"
        }
      }
    }
  } as unknown as Snapshot;
  const notify = listener as ((value: Snapshot) => void) | null;
  assert.ok(notify);
  notify(snapshot);
  await waiting;

  driver.dispatchCassetteIntent(defaultCassetteID, event);
  assert.equal(ready, true);
  assert.equal(intents[0]?.type, "submit/requested");
  driver.dispose();
});

test("rejects an unregistered Session without canonical child lineage", () => {
  type Snapshot = ReturnType<AgentSessionEngine["getSnapshot"]>;
  const driver = installAgentSessionActivityReplayDriver({
    engine: {
      dispatch() {},
      getSnapshot() {
        return {
          sessionLifecycle: {
            sessionsById: {
              "child-2": {
                agentSessionId: "child-2",
                kind: "child",
                rootAgentSessionId: "root-2",
                workspaceId: "workspace-1"
              }
            }
          }
        } as unknown as Snapshot;
      },
      identity: { origin: "test", workspaceId: "workspace-1" }
    }
  });
  driver.registerCassette({
    agentSessionIds: ["root-1"],
    cassetteId: defaultCassetteID
  });

  assert.throws(
    () =>
      driver.dispatchCassetteIntent(
        defaultCassetteID,
        activityEvent({
          agentSessionId: "child-2",
          correlationId: "child-submit-2",
          kind: "intent",
          payload: {
            clientSubmitId: "child-submit-2",
            content: [{ text: "continue", type: "text" }],
            requestedAtUnixMs: 100
          },
          type: "submit/requested"
        })
      ),
    /does not own Agent Session child-2/
  );
  driver.dispose();
});

test("Cassette-scoped verification binds the effect to its observed commandId", async () => {
  const driver = installDriver([]);
  driver.observeCommand(
    sendPromptCommand("command-1", "session-1", "submit-1")
  );
  driver.observeIntent(
    commandResult({
      commandId: "command-1",
      commandType: "queue/sendPrompt",
      correlationId: "submit-1",
      outcome: "succeeded"
    })
  );

  await driver.verifyCassetteEffect(
    defaultCassetteID,
    effectEvent("session-1", "submit-1", { outcome: "succeeded" })
  );
  driver.dispose();
});

test("verifies each lifecycle effect once using command-specific fields", async () => {
  const cases: readonly [EngineExternalCommand, AgentSessionActivityEvent][] = [
    [
      {
        action: "set",
        agentSessionId: "session-1",
        clientSubmitId: "goal-submit-1",
        commandId: "goal-command-1",
        correlationId: "goal-submit-1",
        objective: "ship it",
        type: "goal/control",
        workspaceId: "workspace-1"
      },
      activityEvent({
        agentSessionId: "session-1",
        correlationId: "goal-submit-1",
        kind: "effect",
        payload: {
          action: "set",
          clientSubmitId: "goal-submit-1",
          objective: "ship it",
          outcome: "succeeded"
        },
        type: "goal/control"
      })
    ],
    [
      {
        agentSessionId: "session-1",
        agentTargetId: "local:codex",
        clientSubmitId: "create-1",
        commandId: "activate-1",
        correlationId: "request-1",
        cwd: "/workspace",
        mode: "new",
        type: "session/activate",
        workspaceId: "workspace-1"
      },
      activityEvent({
        agentSessionId: "session-1",
        // The recorder correlates the effect with the activation intent's
        // clientSubmitId; the engine command itself carries requestId.
        correlationId: "create-1",
        kind: "effect",
        payload: {
          agentTargetId: "local:codex",
          clientSubmitId: "create-1",
          cwd: "/workspace",
          mode: "new",
          outcome: "succeeded"
        },
        type: "session/activate"
      })
    ],
    [
      {
        action: "approve",
        agentSessionId: "session-1",
        commandId: "respond-1",
        correlationId: "interaction-1",
        requestId: "request-1",
        turnId: "turn-1",
        type: "interaction/respond",
        workspaceId: "workspace-1"
      },
      activityEvent({
        agentSessionId: "session-1",
        correlationId: "interaction-1",
        kind: "effect",
        payload: {
          action: "approve",
          outcome: "succeeded",
          requestId: "request-1",
          turnId: "turn-1"
        },
        type: "interaction/respond"
      })
    ],
    [
      {
        action: "implement",
        agentSessionId: "session-1",
        commandId: "plan-1",
        correlationId: "plan-correlation-1",
        idempotencyKey: "decision-1",
        promptKind: "plan-implementation",
        requestId: "turn-1",
        turnId: "turn-1",
        type: "plan/submitDecision",
        workspaceId: "workspace-1"
      },
      activityEvent({
        agentSessionId: "session-1",
        correlationId: "plan-correlation-1",
        kind: "effect",
        payload: {
          action: "implement",
          idempotencyKey: "decision-1",
          outcome: "succeeded",
          promptKind: "plan-implementation",
          requestId: "turn-1",
          turnId: "turn-1"
        },
        type: "plan/submitDecision"
      })
    ],
    [
      {
        agentSessionId: "session-1",
        commandId: "cancel-1",
        turnId: "turn-1",
        type: "turn/cancel",
        workspaceId: "workspace-1"
      },
      activityEvent({
        agentSessionId: "session-1",
        kind: "effect",
        payload: { outcome: "succeeded", turnId: "turn-1" },
        type: "turn/cancel"
      })
    ],
    [
      {
        agentSessionId: "session-1",
        commandId: "settings-1",
        correlationId: "session-1",
        settings: { planMode: true },
        type: "session/updateSettings",
        workspaceId: "workspace-1"
      },
      activityEvent({
        agentSessionId: "session-1",
        correlationId: "session-1",
        kind: "effect",
        payload: {
          outcome: "succeeded",
          settings: { planMode: true }
        },
        type: "session/updateSettings"
      })
    ]
  ];

  for (const [command, event] of cases) {
    const driver = installDriver([]);
    driver.observeCommand(command);
    driver.observeIntent(
      commandResult({
        commandId: command.commandId,
        commandType: command.type,
        ...("correlationId" in command
          ? { correlationId: command.correlationId }
          : {}),
        outcome: "succeeded"
      })
    );
    await driver.verifyCassetteEffect(defaultCassetteID, event);
    assert.throws(
      () => driver.observeCommand(command),
      /duplicate renderer activity replay commandId/
    );
    driver.dispose();
  }
});

test("routes equal correlations in different cassettes by generated commandId", async () => {
  const driver = installDriver([]);
  driver.registerCassette({
    agentSessionIds: ["session-a"],
    cassetteId: "cassette-a"
  });
  driver.registerCassette({
    agentSessionIds: ["session-b"],
    cassetteId: "cassette-b"
  });

  driver.observeCommand(sendPromptCommand("command-a", "session-a", "same"));
  driver.observeCommand(sendPromptCommand("command-b", "session-b", "same"));
  const verifyA = driver.verifyCassetteEffect(
    "cassette-a",
    effectEvent("session-a", "same", { outcome: "succeeded" })
  );
  const verifyB = driver.verifyCassetteEffect(
    "cassette-b",
    effectEvent("session-b", "same", {
      errorCode: "turn_busy",
      outcome: "failed"
    })
  );

  driver.observeIntent(
    commandResult({
      commandId: "command-b",
      commandType: "queue/sendPrompt",
      correlationId: "same",
      errorCode: "turn_busy",
      outcome: "failed"
    })
  );
  driver.observeIntent(
    commandResult({
      commandId: "command-a",
      commandType: "queue/sendPrompt",
      correlationId: "same",
      outcome: "succeeded"
    })
  );

  await Promise.all([verifyA, verifyB]);
  driver.dispose();
});

test("fails closed for an unknown command result without correlation fallback", () => {
  const driver = installDriver([]);
  driver.registerCassette({
    agentSessionIds: ["session-a"],
    cassetteId: "cassette-a"
  });

  assert.throws(
    () =>
      driver.observeIntent(
        commandResult({
          commandId: "unknown",
          commandType: "queue/sendPrompt",
          correlationId: "same",
          outcome: "succeeded"
        })
      ),
    /unknown renderer activity replay command result unknown/
  );
  assert.throws(
    () =>
      driver.dispatchCassetteIntent(
        "cassette-a",
        activityEvent({
          agentSessionId: "session-a",
          kind: "intent",
          payload: {},
          type: "queue/resumed"
        })
      ),
    /unknown renderer activity replay command result unknown/
  );
  driver.dispose();
});

test("ignores command results that the recorder does not capture", () => {
  const driver = installDriver([]);
  driver.registerCassette({
    agentSessionIds: ["session-a"],
    cassetteId: "cassette-a"
  });

  driver.observeIntent(
    commandResult({
      commandId: "attention-hydrate:workspace-1:local",
      commandType: "attention/readState/read",
      correlationId: "attention-hydrate:workspace-1:local",
      outcome: "succeeded"
    })
  );

  driver.dispose();
});

test("fails closed for duplicate commandIds", () => {
  const driver = installDriver([]);
  driver.registerCassette({
    agentSessionIds: ["session-a"],
    cassetteId: "cassette-a"
  });
  const command = sendPromptCommand("duplicate", "session-a", "submit-1");
  driver.observeCommand(command);

  assert.throws(
    () => driver.observeCommand(command),
    /duplicate renderer activity replay commandId duplicate/
  );
  driver.dispose();
});

test("fails closed when a command has no registered cassette", () => {
  const driver = installDriver([]);
  driver.registerCassette({
    agentSessionIds: ["session-a"],
    cassetteId: "cassette-a"
  });

  assert.throws(
    () =>
      driver.observeCommand(
        sendPromptCommand("command-b", "session-b", "submit-1")
      ),
    /no replay cassette registered.*session-b/
  );
  driver.dispose();
});

test("reports outcome and error detail mismatches within the owning cassette", async () => {
  const driver = installDriver([]);
  driver.observeCommand(
    sendPromptCommand("command-1", "session-1", "submit-1")
  );
  driver.observeIntent(
    commandResult({
      commandId: "command-1",
      commandType: "queue/sendPrompt",
      correlationId: "submit-1",
      errorCode: "actual_code",
      errorReason: "actual_reason",
      outcome: "failed"
    })
  );

  await assert.rejects(
    driver.verifyCassetteEffect(
      defaultCassetteID,
      effectEvent("session-1", "submit-1", {
        errorCode: "expected_code",
        errorReason: "expected_reason",
        outcome: "succeeded"
      })
    ),
    (error: Error) => {
      assert.match(error.message, /outcome expected "succeeded" got "failed"/);
      assert.match(
        error.message,
        /errorCode expected "expected_code" got "actual_code"/
      );
      assert.match(
        error.message,
        /errorReason expected "expected_reason" got "actual_reason"/
      );
      return true;
    }
  );
  driver.dispose();
});

test("times out when no command is generated for an expected effect", async () => {
  const driver = installDriver([], 5);

  await assert.rejects(
    driver.verifyCassetteEffect(
      defaultCassetteID,
      effectEvent("session-1", "submit-1", { outcome: "succeeded" })
    ),
    /timed out waiting for renderer effect queue\/sendPrompt \(submit-1\)/
  );
  driver.dispose();
});

test("removing one cassette rejects only its waiters", async () => {
  const driver = installDriver([]);
  const runA = driver.registerCassette({
    agentSessionIds: ["session-a"],
    cassetteId: "cassette-a"
  });
  driver.registerCassette({
    agentSessionIds: ["session-b"],
    cassetteId: "cassette-b"
  });
  const verifyA = driver.verifyCassetteEffect(
    "cassette-a",
    effectEvent("session-a", "submit-a", { outcome: "succeeded" })
  );
  driver.observeCommand(
    sendPromptCommand("command-b", "session-b", "submit-b")
  );
  const verifyB = driver.verifyCassetteEffect(
    "cassette-b",
    effectEvent("session-b", "submit-b", { outcome: "succeeded" })
  );

  runA.dispose();
  driver.observeIntent(
    commandResult({
      commandId: "command-b",
      commandType: "queue/sendPrompt",
      correlationId: "submit-b",
      outcome: "succeeded"
    })
  );

  await assert.rejects(verifyA, /replay cassette was disposed/);
  await verifyB;
  driver.dispose();
  assert.equal(replayGlobal().__tuttiAgentSessionReplayDriver, undefined);
});

function installDriver(
  intents: EngineIntent[],
  effectTimeoutMs = 100
): AgentSessionActivityReplayDriver {
  const engine = {
    dispatch(intent) {
      intents.push(intent);
    },
    identity: { origin: "test", workspaceId: "workspace-1" }
  } satisfies Pick<AgentSessionEngine, "dispatch" | "identity">;
  const driver = installAgentSessionActivityReplayDriver({
    effectTimeoutMs,
    engine
  });
  driver.registerCassette({
    agentSessionIds: ["session-1", "session-existing"],
    cassetteId: defaultCassetteID
  });
  return driver;
}

function activityEvent(
  overrides: Partial<AgentSessionActivityEvent> &
    Pick<AgentSessionActivityEvent, "kind" | "payload" | "type">
): AgentSessionActivityEvent {
  return {
    eventId: "event-1",
    occurredAtUnixMs: 100,
    schemaVersion: 3,
    scopeId: "workspace-1",
    sequence: 1,
    ...overrides
  };
}

function effectEvent(
  agentSessionId: string,
  correlationId: string,
  payload: AgentSessionActivityEvent["payload"]
): AgentSessionActivityEvent {
  return activityEvent({
    agentSessionId,
    correlationId,
    kind: "effect",
    payload: {
      clientSubmitId: correlationId,
      content: [{ text: "continue", type: "text" }],
      promptId: correlationId,
      ...payload
    },
    type: "queue/sendPrompt"
  });
}

function sendPromptCommand(
  commandId: string,
  agentSessionId: string,
  correlationId: string
): Extract<EngineExternalCommand, { type: "queue/sendPrompt" }> {
  return {
    agentSessionId,
    clientSubmitId: correlationId,
    commandId,
    content: [{ text: "continue", type: "text" }],
    correlationId,
    promptId: correlationId,
    type: "queue/sendPrompt",
    workspaceId: "workspace-1"
  };
}

function commandResult(
  overrides: Partial<Extract<EngineIntent, { type: "engine/commandResult" }>> &
    Pick<
      Extract<EngineIntent, { type: "engine/commandResult" }>,
      "commandType" | "outcome"
    >
): Extract<EngineIntent, { type: "engine/commandResult" }> {
  return {
    commandId: "command-1",
    type: "engine/commandResult",
    ...overrides
  };
}

function replayGlobal(): typeof globalThis & {
  __tuttiAgentSessionReplayDriver?: AgentSessionActivityReplayDriver;
} {
  return globalThis as typeof globalThis & {
    __tuttiAgentSessionReplayDriver?: AgentSessionActivityReplayDriver;
  };
}
