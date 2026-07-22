import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialPendingIntentsState,
  pendingIntentsReducer
} from "./pendingIntents.reducer.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";
import {
  validateScopedSessionResult,
  validateSendInputResult
} from "./commandResult.validation.ts";

test("submit intent declares its confirmation deadline", () => {
  const result = reduce(createInitialPendingIntentsState(), submit());
  assert.equal(
    result.state.submitsByClientSubmitId["submit-1"]?.status,
    "requested"
  );
  assert.deepEqual(result.commands, [
    {
      dueAtUnixMs: 60_000,
      expiryId: "submit:submit-1",
      type: "engine/scheduleExpiry"
    }
  ]);
});

test("command timeout is uncertain until the same client submit id is durable", () => {
  let state = reduce(createInitialPendingIntentsState(), submit()).state;
  state = reduce(state, {
    type: "engine/commandResult",
    commandId: "queue:send:session-1:1",
    commandType: "queue/sendPrompt",
    correlationId: "submit-1",
    outcome: "timedOut"
  }).state;
  assert.equal(state.submitsByClientSubmitId["submit-1"]?.status, "uncertain");
  const unrelated = reduce(state, {
    type: "message/snapshotReceived",
    messages: [message("submit-2")]
  });
  assert.ok(unrelated.state.submitsByClientSubmitId["submit-1"]);
  const confirmed = reduce(unrelated.state, {
    type: "message/snapshotReceived",
    messages: [message("submit-1")]
  });
  assert.equal(
    confirmed.state.submitsByClientSubmitId["submit-1"]?.status,
    "confirmed"
  );
  assert.deepEqual(confirmed.commands, []);
});

test("successful send records the authoritative turn result", () => {
  let state = reduce(createInitialPendingIntentsState(), submit()).state;
  state = reduce(state, {
    type: "engine/commandResult",
    commandId: "queue:send:session-1:1",
    commandType: "queue/sendPrompt",
    correlationId: "submit-1",
    outcome: "succeeded",
    value: {
      session: {
        agentSessionId: "session-1",
        cwd: "/workspace",
        provider: "codex",
        status: "working",
        title: "Session",
        workspaceId: "workspace-1"
      },
      turnId: "turn-1",
      turn: runningTurn()
    }
  }).state;
  assert.equal(state.submitsByClientSubmitId["submit-1"]?.turnId, "turn-1");
  assert.equal(state.submitsByClientSubmitId["submit-1"]?.status, "accepted");
});

test("invalid successful send results remain uncertain for canonical reconciliation", () => {
  const invalidValues = [
    undefined,
    {
      session: { ...session("session-1"), workspaceId: "workspace-other" },
      turnId: "turn-1",
      turn: runningTurn()
    },
    {
      session: session("session-other"),
      turnId: "turn-1",
      turn: { ...runningTurn(), agentSessionId: "session-other" }
    },
    {
      session: session("session-1"),
      turnId: "turn-other",
      turn: runningTurn()
    }
  ];
  for (const value of invalidValues) {
    let state = reduce(createInitialPendingIntentsState(), submit()).state;
    state = reduce(state, {
      type: "engine/commandResult",
      commandId: "queue:send:session-1:1",
      commandType: "queue/sendPrompt",
      correlationId: "submit-1",
      outcome: "succeeded",
      value
    }).state;
    const record = state.submitsByClientSubmitId["submit-1"];
    assert.equal(record?.status, "uncertain");
    assert.equal(record?.errorCode, "invalid_command_result");
    assert.equal(record?.turnId, null);
  }
});

test("an explicit settled turn confirms its accepted submit", () => {
  let state = reduce(createInitialPendingIntentsState(), submit()).state;
  state = reduce(state, {
    type: "engine/commandResult",
    commandId: "queue:send:session-1:1",
    commandType: "queue/sendPrompt",
    correlationId: "submit-1",
    outcome: "succeeded",
    value: {
      session: session("session-1"),
      turnId: "turn-1",
      turn: runningTurn()
    }
  }).state;
  const turn = {
    turnId: "turn-1",
    agentSessionId: "session-1",
    origin: "user_prompt" as const,
    phase: "settled" as const,
    outcome: "completed" as const,
    startedAtUnixMs: 1,
    settledAtUnixMs: 2,
    updatedAtUnixMs: 2
  };
  const result = pendingIntentsReducer(
    state,
    { type: "turn/upserted", turn },
    {
      deletedSessionIds: {},
      turnsById: { [canonicalTurnKey("session-1", "turn-1")]: turn },
      sendResultValidation: validateSendInputResult(
        {
          session: session("session-1"),
          turnId: "turn-1",
          turn: runningTurn()
        },
        state.submitsByClientSubmitId["submit-1"]
      )
    }
  );
  assert.equal(
    result.state.submitsByClientSubmitId["submit-1"]?.status,
    "confirmed"
  );
});

test("a late successful send result confirms against an already settled turn", () => {
  let state = reduce(createInitialPendingIntentsState(), submit()).state;
  const turn = {
    turnId: "turn-1",
    agentSessionId: "session-1",
    origin: "user_prompt" as const,
    phase: "settled" as const,
    outcome: "completed" as const,
    startedAtUnixMs: 1,
    settledAtUnixMs: 2,
    updatedAtUnixMs: 2
  };
  const result = pendingIntentsReducer(
    state,
    {
      type: "engine/commandResult",
      commandId: "queue:send:session-1:1",
      commandType: "queue/sendPrompt",
      correlationId: "submit-1",
      outcome: "succeeded",
      value: {
        session: session("session-1"),
        turnId: "turn-1",
        turn: runningTurn()
      }
    },
    {
      deletedSessionIds: {},
      turnsById: { [canonicalTurnKey("session-1", "turn-1")]: turn },
      sendResultValidation: validateSendInputResult(
        {
          session: session("session-1"),
          turnId: "turn-1",
          turn: runningTurn()
        },
        state.submitsByClientSubmitId["submit-1"]
      )
    }
  );
  assert.equal(
    result.state.submitsByClientSubmitId["submit-1"]?.status,
    "confirmed"
  );
});

test("activation intent owns the transport command and confirmation deadline", () => {
  const result = reduce(createInitialPendingIntentsState(), activation());
  const pendingActivation = result.state.activationsByRequestId["activation-1"];
  assert.equal(pendingActivation?.status, "requested");
  assert.equal(pendingActivation?.displayPrompt, "/browser");
  assert.equal(pendingActivation?.optimisticTitle, "Review browser flow");
  assert.equal(pendingActivation?.railSectionKey, "project:/workspace");
  assert.deepEqual(pendingActivation?.content, [
    { type: "text", text: "hello" }
  ]);
  assert.deepEqual(result.commands, [
    {
      dueAtUnixMs: 120_000,
      expiryId: "activation:activation-1",
      type: "engine/scheduleExpiry"
    },
    {
      agentSessionId: "session-new",
      agentTargetId: "target-1",
      clientSubmitId: "submit-new",
      commandId: "activate:activation-1",
      correlationId: "activation-1",
      cwd: "/workspace",
      initialContent: [{ type: "text", text: "runtime instructions" }],
      initialDisplayPrompt: "/browser",
      submitDiagnostics: { submittedAtUnixMs: 1 },
      mode: "new",
      settings: { model: "model-1" },
      timeoutMs: 90_000,
      title: "New session",
      type: "session/activate",
      workspaceId: "workspace-1"
    }
  ]);
});

test("control activation can carry content without expecting a Turn", () => {
  const intent = {
    ...activation(),
    content: [{ type: "text" as const, text: "/goal ship it" }],
    initialGoalControl: { action: "set" as const, objective: "ship it" },
    initialTurnExpected: false,
    runtimeContent: [{ type: "text" as const, text: "/goal ship it" }]
  };
  const result = reduce(createInitialPendingIntentsState(), intent);
  const pending = result.state.activationsByRequestId["activation-1"];
  assert.equal(pending?.initialTurnExpected, false);
  assert.deepEqual(
    result.commands.find((command) => command.type === "session/activate"),
    {
      agentSessionId: "session-new",
      agentTargetId: "target-1",
      clientSubmitId: "submit-new",
      commandId: "activate:activation-1",
      correlationId: "activation-1",
      cwd: "/workspace",
      initialContent: [{ type: "text", text: "/goal ship it" }],
      initialDisplayPrompt: "/browser",
      initialGoalControl: { action: "set", objective: "ship it" },
      submitDiagnostics: { submittedAtUnixMs: 1 },
      mode: "new",
      settings: { model: "model-1" },
      timeoutMs: 90_000,
      title: "New session",
      type: "session/activate",
      workspaceId: "workspace-1"
    }
  );
});

test("goal control send result confirms without manufacturing a Turn", () => {
  const state = reduce(createInitialPendingIntentsState(), submit()).state;
  const validation = validateSendInputResult(
    {
      kind: "goalControl",
      session: session("session-1"),
      goal: { objective: "ship it", status: "active" as const }
    },
    state.submitsByClientSubmitId["submit-1"]
  );
  const result = pendingIntentsReducer(
    state,
    {
      type: "engine/commandResult",
      commandId: "queue:send:session-1:1",
      commandType: "queue/sendPrompt",
      correlationId: "submit-1",
      outcome: "succeeded"
    },
    {
      deletedSessionIds: {},
      turnsById: {},
      sendResultValidation: validation
    }
  );
  assert.equal(
    result.state.submitsByClientSubmitId["submit-1"]?.status,
    "confirmed"
  );
  assert.equal(result.state.submitsByClientSubmitId["submit-1"]?.turnId, null);
});

test("malformed turnless goal control result is rejected before session upsert", () => {
  const state = reduce(createInitialPendingIntentsState(), submit()).state;
  const validation = validateSendInputResult(
    {
      kind: "goalControl",
      session: {
        agentSessionId: "session-1",
        workspaceId: "workspace-1"
      }
    },
    state.submitsByClientSubmitId["submit-1"]
  );
  assert.deepEqual(validation, {
    kind: "invalid",
    reason: "send_result_entities_missing"
  });
});

test("timed out activation remains uncertain until its exact session appears", () => {
  let state = reduce(createInitialPendingIntentsState(), activation()).state;
  state = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "timedOut",
    type: "engine/commandResult"
  }).state;
  assert.equal(
    state.activationsByRequestId["activation-1"]?.status,
    "uncertain"
  );
  state = reduce(state, {
    sessions: [session("another-session")],
    type: "session/snapshotReceived"
  }).state;
  assert.equal(
    state.activationsByRequestId["activation-1"]?.status,
    "uncertain"
  );
  state = reduce(state, {
    sessions: [session("session-new")],
    type: "session/snapshotReceived"
  }).state;
  assert.equal(
    state.activationsByRequestId["activation-1"]?.status,
    "confirmed"
  );
});

test("a realtime session upsert confirms its pending activation", () => {
  const state = reduce(createInitialPendingIntentsState(), activation()).state;
  const confirmed = reduce(state, {
    session: { ...session("session-new"), createdAtUnixMs: 1 },
    type: "session/upserted"
  });
  assert.equal(
    confirmed.state.activationsByRequestId["activation-1"]?.status,
    "confirmed"
  );
});

test("authoritative activation failure is retained for the view to dismiss", () => {
  let state = reduce(createInitialPendingIntentsState(), activation()).state;
  state = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      activation: { status: "failed" },
      error: { code: "auth_required", message: "Sign in required" },
      session: { ...session("session-new"), status: "failed" }
    }
  }).state;
  const record = state.activationsByRequestId["activation-1"];
  assert.equal(record?.status, "failed");
  assert.equal(record?.errorCode, "auth_required");
  assert.equal(record?.errorMessage, "Sign in required");
});

test("invalid successful activation acknowledgement remains uncertain", () => {
  let state = reduce(createInitialPendingIntentsState(), activation()).state;
  state = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: { unexpected: true }
  }).state;
  assert.equal(
    state.activationsByRequestId["activation-1"]?.status,
    "uncertain"
  );
  assert.equal(
    state.activationsByRequestId["activation-1"]?.errorCode,
    "invalid_command_result"
  );
});

test("activation confirmation requires an exact workspace-scoped fresh snapshot", () => {
  let state = reduce(createInitialPendingIntentsState(), activation()).state;
  state = reduce(state, {
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        ...session("session-new"),
        createdAtUnixMs: 1,
        workspaceId: "workspace-other"
      }
    ],
    type: "session/snapshotReceived"
  }).state;
  assert.equal(
    state.activationsByRequestId["activation-1"]?.status,
    "requested"
  );
});

test("confirmed activation emits its request-scoped pending settings command once", () => {
  let state = reduce(createInitialPendingIntentsState(), activation()).state;
  state = reduce(state, {
    agentSessionId: "session-new",
    settings: { model: "model-2" },
    type: "activation/settingsPatched"
  }).state;
  const confirmed = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      activation: { status: "active" },
      session: { ...session("session-new"), createdAtUnixMs: 1 }
    }
  });
  assert.deepEqual(confirmed.commands, []);
  const attached = reduce(confirmed.state, {
    sessions: [{ ...session("session-new"), createdAtUnixMs: 1 }],
    type: "session/snapshotReceived"
  });
  assert.deepEqual(attached.commands, [
    {
      agentSessionId: "session-new",
      commandId: "activation-settings:activation-1",
      correlationId: "activation-1",
      settings: { model: "model-2" },
      type: "session/updateSettings",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(
    reduce(attached.state, {
      sessions: [{ ...session("session-new"), createdAtUnixMs: 1 }],
      type: "session/snapshotReceived"
    }).commands,
    []
  );
  const settingsSucceeded = reduce(attached.state, {
    commandId: "activation-settings:activation-1",
    commandType: "session/updateSettings",
    correlationId: "activation-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      agentSessionId: "session-new",
      session: { ...session("session-new"), settings: { model: "model-2" } }
    }
  });
  assert.equal(
    settingsSucceeded.state.activationsByRequestId["activation-1"]
      ?.pendingSettingsPatch,
    undefined
  );
});

test("settings update failure remains request-scoped and retryable without double send", () => {
  let state = reduce(createInitialPendingIntentsState(), activation()).state;
  state = reduce(state, {
    agentSessionId: "session-new",
    settings: { model: "model-2" },
    type: "activation/settingsPatched"
  }).state;
  const confirmed = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      activation: { status: "active" },
      session: { ...session("session-new"), createdAtUnixMs: 1 }
    }
  });
  const attached = reduce(confirmed.state, {
    sessions: [{ ...session("session-new"), createdAtUnixMs: 1 }],
    type: "session/snapshotReceived"
  });
  assert.equal(attached.commands[0]?.type, "session/updateSettings");
  const failed = reduce(attached.state, {
    commandId: "activation-settings:activation-1",
    commandType: "session/updateSettings",
    correlationId: "activation-1",
    errorMessage: "settings failed",
    outcome: "failed",
    type: "engine/commandResult"
  });
  assert.equal(
    failed.state.activationsByRequestId["activation-1"]?.settingsUpdateStatus,
    "failed"
  );
  assert.deepEqual(
    failed.state.activationsByRequestId["activation-1"]?.pendingSettingsPatch,
    { model: "model-2" }
  );
  const retried = reduce(failed.state, {
    agentSessionId: "session-new",
    settings: { model: "model-3" },
    type: "activation/settingsPatched"
  });
  assert.equal(retried.commands[0]?.type, "session/updateSettings");
  const timedOut = reduce(retried.state, {
    commandId: "activation-settings:activation-1",
    commandType: "session/updateSettings",
    correlationId: "activation-1",
    outcome: "timedOut",
    type: "engine/commandResult"
  });
  assert.equal(
    timedOut.state.activationsByRequestId["activation-1"]?.settingsUpdateStatus,
    "unknown"
  );
});

test("failed, superseded, and late reused activations never flush settings", () => {
  let state = reduce(createInitialPendingIntentsState(), activation()).state;
  state = reduce(state, {
    ...activation(),
    requestId: "activation-2",
    requestedAtUnixMs: 10
  }).state;
  state = reduce(state, {
    agentSessionId: "session-new",
    settings: { model: "model-2" },
    type: "activation/settingsPatched"
  }).state;
  const oldConfirmed = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      activation: { status: "active" },
      session: { ...session("session-new"), createdAtUnixMs: 1 }
    }
  });
  assert.deepEqual(oldConfirmed.commands, []);
  const lateReuse = reduce(oldConfirmed.state, {
    sessions: [{ ...session("session-new"), createdAtUnixMs: 2 }],
    type: "session/snapshotReceived"
  });
  assert.deepEqual(lateReuse.commands, []);
  const failed = reduce(lateReuse.state, {
    commandId: "activate:activation-2",
    commandType: "session/activate",
    correlationId: "activation-2",
    errorMessage: "failed",
    outcome: "failed",
    type: "engine/commandResult"
  });
  assert.deepEqual(failed.commands, []);
});

test("same-session activation requests are latest-wins and old results cannot revive", () => {
  let state = reduce(createInitialPendingIntentsState(), activation()).state;
  const newer = reduce(state, {
    ...activation(),
    requestId: "activation-2",
    requestedAtUnixMs: 10
  });
  assert.equal(newer.state.activationsByRequestId["activation-1"], undefined);
  assert.equal(
    newer.state.activationsByRequestId["activation-2"]?.status,
    "requested"
  );
  assert.equal(newer.commands[0]?.type, "engine/cancelExpiry");
  const lateOldResult = reduce(newer.state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      activation: { status: "active" },
      session: { ...session("session-new"), createdAtUnixMs: 1 }
    }
  });
  assert.deepEqual(lateOldResult.commands, []);
  assert.equal(
    lateOldResult.state.activationsByRequestId["activation-2"]?.status,
    "requested"
  );
});

function submit() {
  return {
    type: "submit/requested" as const,
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ type: "text" as const, text: "hello" }],
    expiresAtUnixMs: 60_000,
    requestedAtUnixMs: 1,
    workspaceId: "workspace-1"
  };
}

function activation() {
  return {
    type: "activation/requested" as const,
    agentSessionId: "session-new",
    agentTargetId: "target-1",
    clientSubmitId: "submit-new",
    content: [{ type: "text" as const, text: "hello" }],
    cwd: "/workspace",
    expiresAtUnixMs: 120_000,
    initialDisplayPrompt: "/browser",
    optimisticTitle: "Review browser flow",
    railSectionKey: "project:/workspace",
    runtimeContent: [{ type: "text" as const, text: "runtime instructions" }],
    submitDiagnostics: { submittedAtUnixMs: 1 },
    mode: "new" as const,
    requestedAtUnixMs: 1,
    requestId: "activation-1",
    settings: { model: "model-1" },
    title: "New session",
    workspaceId: "workspace-1"
  };
}

function session(agentSessionId: string) {
  return {
    activeTurnId: null,
    agentSessionId,
    cwd: "/workspace",
    createdAtUnixMs: 1,
    provider: "codex",
    latestTurnInteractions: [],
    pendingInteractions: [],
    status: "ready",
    title: "Session",
    workspaceId: "workspace-1"
  };
}

function runningTurn() {
  return {
    agentSessionId: "session-1",
    origin: "user_prompt" as const,
    phase: "running" as const,
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 1
  };
}

function message(clientSubmitId: string) {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId: `message-${clientSubmitId}`,
    occurredAtUnixMs: 2,
    payload: { clientSubmitId },
    role: "user",
    turnId: "turn-1",
    version: 1
  };
}

function reduce(
  state: ReturnType<typeof createInitialPendingIntentsState>,
  intent: Parameters<typeof pendingIntentsReducer>[1]
) {
  return pendingIntentsReducer(state, intent, {
    deletedSessionIds: {},
    turnsById: {},
    sendResultValidation:
      intent.type === "engine/commandResult" &&
      intent.commandType === "queue/sendPrompt" &&
      intent.outcome === "succeeded"
        ? validateSendInputResult(
            intent.value,
            state.submitsByClientSubmitId[intent.correlationId?.trim() ?? ""]
          )
        : null,
    settingsResultValidation:
      intent.type === "engine/commandResult" &&
      intent.commandType === "session/updateSettings" &&
      intent.outcome === "succeeded"
        ? (() => {
            const activation =
              state.activationsByRequestId[intent.correlationId?.trim() ?? ""];
            return validateScopedSessionResult(
              intent.value,
              activation
                ? {
                    agentSessionId: activation.agentSessionId,
                    workspaceId: activation.workspaceId
                  }
                : undefined,
              true
            );
          })()
        : null
  });
}
