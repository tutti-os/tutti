import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialEngineRuntimeState,
  engineRuntimeReducer
} from "./engineRuntime.reducer.ts";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import type { EngineIntent, EngineRuntimeState } from "./types.ts";
import type { AgentActivitySessionCapabilities } from "../types.ts";

function reduceAll(intents: readonly EngineIntent[]): EngineRuntimeState {
  let state = createInitialEngineRuntimeState();
  for (const intent of intents) {
    state = engineRuntimeReducer(state, intent).state;
  }
  return state;
}

test("initial engine runtime state is idle and empty", () => {
  assert.deepEqual(createInitialEngineRuntimeState(), {
    connection: "unknown",
    lastCommandResult: null,
    lastExpiredIntentId: null,
    processedIntentCount: 0,
    workspaceReconcile: {
      commandId: null,
      errorCode: null,
      errorMessage: null,
      status: "idle"
    }
  });
});

test("every intent increments the processed intent counter", () => {
  const state = reduceAll([
    { status: "connected", type: "engine/connectionChanged" },
    { probeId: "p-1", type: "engine/probeRequested" },
    {
      commandId: "p-1",
      commandType: "engine/probe",
      outcome: "succeeded",
      type: "engine/commandResult"
    },
    { dueAtUnixMs: 10, expiryId: "e-1", type: "engine/intentExpired" }
  ]);
  assert.equal(state.processedIntentCount, 4);
  assert.equal(state.connection, "connected");
  assert.deepEqual(state.lastCommandResult, {
    commandId: "p-1",
    outcome: "succeeded"
  });
  assert.equal(state.lastExpiredIntentId, "e-1");
});

test("probe request emits an external probe command", () => {
  const result = engineRuntimeReducer(createInitialEngineRuntimeState(), {
    probeId: "p-9",
    timeoutMs: 250,
    type: "engine/probeRequested"
  });
  assert.deepEqual(result.commands, [
    { commandId: "p-9", timeoutMs: 250, type: "engine/probe" }
  ]);
});

test("connected transition requests one workspace reconcile", () => {
  const initial = createInitialEngineRuntimeState();
  const connected = engineRuntimeReducer(initial, {
    status: "connected",
    type: "engine/connectionChanged",
    workspaceId: "workspace-1"
  });
  assert.equal(connected.commands[0]?.type, "engine/reconcileWorkspace");

  const duplicate = engineRuntimeReducer(connected.state, {
    status: "connected",
    type: "engine/connectionChanged",
    workspaceId: "workspace-1"
  });
  assert.equal(duplicate.commands.length, 0);

  const completed = engineRuntimeReducer(duplicate.state, {
    commandId: connected.state.workspaceReconcile.commandId ?? "",
    commandType: "engine/reconcileWorkspace",
    outcome: "succeeded",
    type: "engine/commandResult"
  });

  const disconnected = engineRuntimeReducer(completed.state, {
    status: "disconnected",
    type: "engine/connectionChanged",
    workspaceId: "workspace-1"
  });
  const reconnected = engineRuntimeReducer(disconnected.state, {
    status: "connected",
    type: "engine/connectionChanged",
    workspaceId: "workspace-1"
  });
  assert.equal(reconnected.commands[0]?.type, "engine/reconcileWorkspace");
});

test("workspace start loads once and failed load requires explicit retry", () => {
  const initial = engineRuntimeReducer(createInitialEngineRuntimeState(), {
    type: "workspace/reconcileRequested",
    workspaceId: "workspace-1"
  });
  assert.equal(initial.commands.length, 1);
  const duplicate = engineRuntimeReducer(initial.state, {
    type: "workspace/reconcileRequested",
    workspaceId: "workspace-1"
  });
  assert.equal(duplicate.commands.length, 0);
  const failed = engineRuntimeReducer(duplicate.state, {
    commandId: initial.state.workspaceReconcile.commandId ?? "",
    commandType: "engine/reconcileWorkspace",
    errorCode: "load_failed",
    outcome: "failed",
    type: "engine/commandResult"
  });
  assert.equal(failed.state.workspaceReconcile.status, "failed");
  assert.equal(
    engineRuntimeReducer(failed.state, {
      type: "workspace/reconcileRequested",
      workspaceId: "workspace-1"
    }).commands.length,
    0
  );
  const retry = engineRuntimeReducer(failed.state, {
    retry: true,
    type: "workspace/reconcileRequested",
    workspaceId: "workspace-1"
  });
  assert.equal(retry.commands.length, 1);
});

test("expiry request and cancellation emit internal clock commands", () => {
  const requested = engineRuntimeReducer(createInitialEngineRuntimeState(), {
    dueAtUnixMs: 500,
    expiryId: "e-7",
    type: "engine/expiryRequested"
  });
  assert.deepEqual(requested.commands, [
    { dueAtUnixMs: 500, expiryId: "e-7", type: "engine/scheduleExpiry" }
  ]);

  const canceled = engineRuntimeReducer(requested.state, {
    expiryId: "e-7",
    type: "engine/expiryCancelRequested"
  });
  assert.deepEqual(canceled.commands, [
    { expiryId: "e-7", type: "engine/cancelExpiry" }
  ]);
});

test("failed command results keep the error message", () => {
  const result = engineRuntimeReducer(createInitialEngineRuntimeState(), {
    commandId: "p-2",
    commandType: "engine/probe",
    errorMessage: "boom",
    outcome: "failed",
    type: "engine/commandResult"
  });
  assert.deepEqual(result.state.lastCommandResult, {
    commandId: "p-2",
    errorMessage: "boom",
    outcome: "failed"
  });
});

test("interleaving: a late command result does not clobber a newer expiry", () => {
  // submit probe -> expiry fires -> stale probe result arrives afterwards
  const state = reduceAll([
    { probeId: "p-1", type: "engine/probeRequested" },
    { dueAtUnixMs: 30, expiryId: "e-1", type: "engine/intentExpired" },
    {
      commandId: "p-1",
      commandType: "engine/probe",
      outcome: "timedOut",
      type: "engine/commandResult"
    }
  ]);
  assert.equal(state.lastExpiredIntentId, "e-1");
  assert.deepEqual(state.lastCommandResult, {
    commandId: "p-1",
    outcome: "timedOut"
  });
});

test("root reducer composes domain slices and commands", () => {
  const initial = createInitialAgentSessionEngineState();
  const result = rootEngineReducer(initial, {
    status: "disconnected",
    type: "engine/connectionChanged"
  });
  assert.equal(result.state.engineRuntime.connection, "disconnected");
  assert.notEqual(result.state, initial);
  assert.deepEqual(result.commands, []);

  const withCommand = rootEngineReducer(result.state, {
    probeId: "p-1",
    type: "engine/probeRequested"
  });
  assert.deepEqual(withCommand.commands, [
    { commandId: "p-1", type: "engine/probe" }
  ]);
});

test("canceling a queued submit atomically removes queue and pending intent", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        activeTurn: {
          agentSessionId: "session-1",
          phase: "running",
          startedAtUnixMs: 1,
          turnId: "turn-1",
          updatedAtUnixMs: 1
        },
        activeTurnId: "turn-1",
        agentSessionId: "session-1",
        cwd: "/workspace",
        provider: "codex",
        title: "Session",
        updatedAtUnixMs: 1,
        workspaceId: "workspace-1"
      }
    ],
    type: "session/snapshotReceived"
  }).state;
  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ type: "text", text: "queued" }],
    expiresAtUnixMs: 120_000,
    requestedAtUnixMs: 2,
    type: "submit/requested",
    workspaceId: "workspace-1"
  }).state;
  assert.ok(state.pendingIntents.submitsByClientSubmitId["submit-1"]);
  assert.equal(
    state.promptQueue.recordsBySessionId["session-1"]?.prompts.length,
    1
  );

  const canceled = rootEngineReducer(state, {
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    type: "submit/canceled"
  });
  assert.equal(
    canceled.state.pendingIntents.submitsByClientSubmitId["submit-1"],
    undefined
  );
  assert.equal(
    canceled.state.promptQueue.recordsBySessionId["session-1"],
    undefined
  );
  assert.deepEqual(canceled.commands, [
    { expiryId: "submit:submit-1", type: "engine/cancelExpiry" }
  ]);
});

test("later queued submit stays requested when its expiry follows the prior delivery", () => {
  let state = createInitialAgentSessionEngineState();
  const runningSession = {
    activeTurn: {
      agentSessionId: "session-1",
      phase: "running" as const,
      startedAtUnixMs: 1,
      turnId: "turn-1",
      updatedAtUnixMs: 1
    },
    activeTurnId: "turn-1",
    agentSessionId: "session-1",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: "Session",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1"
  };
  state = rootEngineReducer(state, {
    sessions: [runningSession],
    type: "session/snapshotReceived"
  }).state;
  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ type: "text", text: "queued" }],
    expiresAtUnixMs: 120_000,
    requestedAtUnixMs: 0,
    type: "submit/requested",
    workspaceId: "workspace-1"
  }).state;
  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    clientSubmitId: "submit-2",
    content: [{ type: "text", text: "queued second" }],
    expiresAtUnixMs: 120_001,
    requestedAtUnixMs: 1,
    type: "submit/requested",
    workspaceId: "workspace-1"
  }).state;

  const settled = rootEngineReducer(state, {
    sessions: [
      {
        ...runningSession,
        activeTurn: {
          ...runningSession.activeTurn,
          phase: "settled",
          settledAtUnixMs: 3,
          updatedAtUnixMs: 3
        },
        activeTurnId: null,
        updatedAtUnixMs: 3
      }
    ],
    type: "session/snapshotReceived"
  });
  const send = settled.commands.find(
    (command) => command.type === "queue/sendPrompt"
  );
  assert.equal(send?.type, "queue/sendPrompt");
  const nextTurn = {
    agentSessionId: "session-1",
    phase: "running" as const,
    startedAtUnixMs: 4,
    turnId: "turn-2",
    updatedAtUnixMs: 4
  };
  const firstDelivered = rootEngineReducer(settled.state, {
    commandId: send?.type === "queue/sendPrompt" ? send.commandId : "",
    commandType: "queue/sendPrompt",
    correlationId: "submit-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      session: {
        ...runningSession,
        activeTurn: nextTurn,
        activeTurnId: "turn-2",
        updatedAtUnixMs: 4
      },
      turn: nextTurn,
      turnId: "turn-2"
    }
  });
  assert.equal(
    firstDelivered.state.pendingIntents.submitsByClientSubmitId["submit-1"]
      ?.status,
    "accepted"
  );
  assert.deepEqual(
    firstDelivered.state.promptQueue.recordsBySessionId[
      "session-1"
    ]?.prompts.map((prompt) => prompt.clientSubmitId),
    ["submit-2"]
  );

  const secondExpired = rootEngineReducer(firstDelivered.state, {
    dueAtUnixMs: 120_001,
    expiryId: "submit:submit-2",
    type: "engine/intentExpired"
  });
  assert.equal(
    secondExpired.state.pendingIntents.submitsByClientSubmitId["submit-2"]
      ?.status,
    "requested"
  );
  assert.deepEqual(
    secondExpired.state.promptQueue.recordsBySessionId[
      "session-1"
    ]?.prompts.map((prompt) => prompt.clientSubmitId),
    ["submit-2"]
  );
  assert.deepEqual(secondExpired.commands, [
    {
      dueAtUnixMs: 240_001,
      expiryId: "submit:submit-2",
      type: "engine/scheduleExpiry"
    }
  ]);
});

test("submit acceptance rejects unknown and cross-workspace canonical sessions atomically", () => {
  const submit = {
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ type: "text" as const, text: "hello" }],
    expiresAtUnixMs: 120_000,
    requestedAtUnixMs: 2,
    type: "submit/requested" as const,
    workspaceId: "workspace-1"
  };
  const unknown = rootEngineReducer(
    createInitialAgentSessionEngineState(),
    submit
  );
  assert.equal(
    unknown.state.pendingIntents.submitsByClientSubmitId["submit-1"],
    undefined
  );
  assert.equal(
    unknown.state.promptQueue.recordsBySessionId["session-1"],
    undefined
  );

  let state = rootEngineReducer(createInitialAgentSessionEngineState(), {
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        agentSessionId: "session-1",
        cwd: "/workspace",
        provider: "codex",
        title: "Session",
        updatedAtUnixMs: 1,
        workspaceId: "workspace-2"
      }
    ],
    type: "session/snapshotReceived"
  }).state;
  const crossWorkspace = rootEngineReducer(state, submit);
  assert.equal(
    crossWorkspace.state.pendingIntents.submitsByClientSubmitId["submit-1"],
    undefined
  );
  assert.equal(
    crossWorkspace.state.promptQueue.recordsBySessionId["session-1"],
    undefined
  );
  assert.deepEqual(crossWorkspace.commands, []);
});

test("an uncertain queued submit cannot be half-canceled", () => {
  let state = createInitialAgentSessionEngineState();
  const runningSession = {
    activeTurn: {
      agentSessionId: "session-1",
      phase: "running" as const,
      startedAtUnixMs: 1,
      turnId: "turn-1",
      updatedAtUnixMs: 1
    },
    activeTurnId: "turn-1",
    agentSessionId: "session-1",
    cwd: "/workspace",
    provider: "codex",
    latestTurnInteractions: [],
    pendingInteractions: [],
    status: "working",
    title: "Session",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1"
  };
  state = rootEngineReducer(state, {
    sessions: [runningSession],
    type: "session/snapshotReceived"
  }).state;
  state = rootEngineReducer(state, {
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ type: "text", text: "queued" }],
    expiresAtUnixMs: 120_000,
    requestedAtUnixMs: 2,
    type: "submit/requested",
    workspaceId: "workspace-1"
  }).state;
  state = rootEngineReducer(state, {
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        ...runningSession,
        activeTurn: {
          ...runningSession.activeTurn,
          phase: "settled",
          settledAtUnixMs: 3,
          updatedAtUnixMs: 3
        },
        activeTurnId: null,
        updatedAtUnixMs: 3
      }
    ],
    type: "session/snapshotReceived"
  }).state;
  const commandId =
    state.promptQueue.recordsBySessionId["session-1"]?.inFlight?.commandId;
  assert.ok(commandId);
  state = rootEngineReducer(state, {
    commandId,
    commandType: "queue/sendPrompt",
    correlationId: "submit-1",
    outcome: "timedOut",
    type: "engine/commandResult"
  }).state;

  const canceled = rootEngineReducer(state, {
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    type: "submit/canceled"
  });
  assert.ok(canceled.state.pendingIntents.submitsByClientSubmitId["submit-1"]);
  assert.equal(
    canceled.state.promptQueue.recordsBySessionId["session-1"]
      ?.uncertainDelivery?.promptId,
    "submit-1"
  );
  assert.deepEqual(canceled.commands, []);

  const expired = rootEngineReducer(canceled.state, {
    dueAtUnixMs: 120_000,
    expiryId: "submit:submit-1",
    type: "engine/intentExpired"
  });
  assert.equal(
    expired.state.pendingIntents.submitsByClientSubmitId["submit-1"]?.status,
    "failed"
  );
  assert.equal(
    expired.state.promptQueue.recordsBySessionId["session-1"]
      ?.uncertainDelivery,
    null
  );
});

test("session tombstone blocks late queue and snapshot resurrection across domains", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    type: "session/snapshotReceived",
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        agentSessionId: "session-1",
        cwd: "/workspace",
        provider: "codex",
        title: "Session",
        updatedAtUnixMs: 1,
        workspaceId: "workspace-1"
      }
    ]
  }).state;
  state = rootEngineReducer(state, {
    type: "session/removed",
    agentSessionId: "session-1"
  }).state;
  const lateEnqueue = rootEngineReducer(state, {
    type: "queue/enqueued",
    agentSessionId: "session-1",
    prompt: {
      content: [{ type: "text", text: "late" }],
      createdAtUnixMs: 2,
      id: "prompt-1"
    },
    workspaceId: "workspace-1"
  });
  assert.equal(
    lateEnqueue.state.promptQueue.recordsBySessionId["session-1"],
    undefined
  );
  const lateSnapshot = rootEngineReducer(lateEnqueue.state, {
    type: "session/snapshotReceived",
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        agentSessionId: "session-1",
        cwd: "/workspace",
        provider: "codex",
        title: "Session",
        updatedAtUnixMs: 3,
        workspaceId: "workspace-1"
      }
    ]
  });
  assert.equal(lateSnapshot.commands.length, 0);
  assert.equal(
    lateSnapshot.state.promptQueue.recordsBySessionId["session-1"],
    undefined
  );
  assert.equal(
    lateSnapshot.state.sessionLifecycle.sessionsById["session-1"],
    undefined
  );
  const lateActivity = rootEngineReducer(lateSnapshot.state, {
    type: "session/activityObserved",
    agentSessionId: "session-1",
    eventType: "session_reconcile_required",
    hasCachedSession: false,
    hasInlineMessages: false,
    inlineApplied: false,
    workspaceId: "workspace-1"
  });
  assert.equal(lateActivity.commands.length, 0);
  assert.equal(
    lateActivity.state.sessionReconcile.recordsBySessionId["session-1"],
    undefined
  );
});

test("an invalid send-now request cannot cancel an unrelated active turn", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    type: "session/snapshotReceived",
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        activeTurn: {
          agentSessionId: "session-1",
          phase: "running",
          startedAtUnixMs: 1,
          turnId: "turn-1",
          updatedAtUnixMs: 1
        },
        activeTurnId: "turn-1",
        agentSessionId: "session-1",
        cwd: "/workspace",
        provider: "codex",
        title: "Session",
        updatedAtUnixMs: 1,
        workspaceId: "workspace-1"
      }
    ]
  }).state;
  const invalid = rootEngineReducer(state, {
    type: "queue/sendNowRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    cancelCommandId: "cancel-1",
    promptId: "missing-prompt",
    timeoutMs: 30_000
  });
  assert.equal(invalid.commands.length, 0);
  assert.equal(
    invalid.state.sessionLifecycle.operationBySessionId["session-1"]?.cancel
      .status,
    "idle"
  );
});

test("ACP send-now fallback waits for the exact turn before canceling", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    type: "session/snapshotReceived",
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        activeTurn: null,
        activeTurnId: "turn-1",
        agentSessionId: "session-1",
        capabilities: capabilities({ interrupt: true }),
        cwd: "/workspace",
        provider: "codex",
        title: "Session",
        updatedAtUnixMs: 1,
        workspaceId: "workspace-1"
      }
    ]
  }).state;
  state = rootEngineReducer(state, {
    type: "queue/enqueued",
    agentSessionId: "session-1",
    prompt: {
      content: [{ type: "text", text: "next" }],
      createdAtUnixMs: 1,
      id: "prompt-1"
    },
    workspaceId: "workspace-1"
  }).state;
  const promoted = rootEngineReducer(state, {
    type: "queue/sendNowRequested",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    cancelCommandId: "cancel-1",
    promptId: "prompt-1",
    timeoutMs: 30_000
  });
  assert.equal(
    promoted.state.sessionLifecycle.operationBySessionId["session-1"]?.cancel
      .status,
    "awaitingTurn"
  );
  assert.deepEqual(promoted.commands, [
    {
      dueAtUnixMs: 30_000,
      expiryId: "cancel:awaiting-turn:cancel-1",
      type: "engine/scheduleExpiry"
    }
  ]);
});

test("composer send-now uses native guidance without canceling the active turn", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    type: "session/snapshotReceived",
    sessions: [runningSession(capabilities({ activeTurnGuidance: true }))]
  }).state;
  const result = rootEngineReducer(state, sendNowSubmit("submit-guidance"));
  const send = result.commands.find(
    (command) => command.type === "queue/sendPrompt"
  );
  assert.equal(send?.type, "queue/sendPrompt");
  assert.equal(send?.type === "queue/sendPrompt" && send.guidance, true);
  assert.equal(
    result.commands.some((command) => command.type === "turn/cancel"),
    false
  );
});

test("composer send-now uses exact-turn cancel before a normal ACP prompt", () => {
  let state = createInitialAgentSessionEngineState();
  state = rootEngineReducer(state, {
    type: "session/snapshotReceived",
    sessions: [runningSession(capabilities({ interrupt: true }))]
  }).state;
  const result = rootEngineReducer(state, sendNowSubmit("submit-fallback"));
  const cancel = result.commands.find(
    (command) => command.type === "turn/cancel"
  );
  assert.equal(cancel?.type, "turn/cancel");
  assert.equal(cancel?.type === "turn/cancel" ? cancel.turnId : null, "turn-1");
  assert.equal(
    result.commands.some((command) => command.type === "queue/sendPrompt"),
    false
  );
  assert.equal(
    result.state.promptQueue.recordsBySessionId["session-1"]?.sendNextPromptId,
    "submit-fallback"
  );
});

function runningSession(capabilityList: AgentActivitySessionCapabilities) {
  return {
    activeTurn: {
      agentSessionId: "session-1",
      phase: "running" as const,
      startedAtUnixMs: 1,
      turnId: "turn-1",
      updatedAtUnixMs: 1
    },
    activeTurnId: "turn-1",
    agentSessionId: "session-1",
    capabilities: capabilityList,
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "opencode",
    title: "Session",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1"
  };
}

function sendNowSubmit(clientSubmitId: string) {
  return {
    agentSessionId: "session-1",
    clientSubmitId,
    content: [{ type: "text" as const, text: "inserted" }],
    expiresAtUnixMs: 120_000,
    requestedAtUnixMs: 2,
    routing: "send_now" as const,
    type: "submit/requested" as const,
    workspaceId: "workspace-1"
  };
}

function capabilities(
  overrides: Partial<AgentActivitySessionCapabilities>
): AgentActivitySessionCapabilities {
  return {
    activeTurnGuidance: false,
    browserUse: false,
    compact: false,
    computerUse: false,
    goalPause: false,
    imageInput: false,
    interrupt: false,
    modelImageInputRequired: false,
    permissionModeChangeDeferred: false,
    permissionModeChangeDuringTurn: false,
    planImplementation: false,
    planMode: false,
    rateLimits: false,
    resumeRunningTurn: false,
    review: false,
    skills: false,
    tokenUsage: false,
    ...overrides
  };
}
