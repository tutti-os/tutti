import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivityTurn
} from "../types.ts";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type {
  CancelResultValidation,
  SendInputResultValidation
} from "./commandResult.validation.ts";
import {
  createInitialPromptQueueState,
  promptQueueReducer
} from "./promptQueue.reducer.ts";
import {
  resolvePromptSendNowStrategy,
  resolveQueuedPromptSendNowStrategy,
  type PromptQueueSendNowStrategy
} from "./promptQueue.sendNow.ts";
import { deriveCanonicalSubmitAvailability } from "./sessionLifecycle.availability.ts";
import {
  createInitialSessionLifecycleState,
  sessionLifecycleReducer
} from "./sessionLifecycle.reducer.ts";
import type { SessionLifecycleState } from "./sessionLifecycle.types.ts";
import type { EngineCommand, EngineCommandResultIntent } from "./types.ts";

test("queue drains from canonical lifecycle, not raw session input", () => {
  const running = canonicalLifecycle("running", 1);
  const queued = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    running
  );
  assert.deepEqual(queued.commands, []);

  const settled = reduce(
    queued.state,
    turnUpserted(settledTurn("turn-1", 2)),
    canonicalLifecycle("settled", 2)
  );
  assert.equal(settled.commands[0]?.type, "queue/sendPrompt");
  assert.equal(settled.commands[0]?.commandId, "queue:send:session-1:1");
});

test("available canonical lifecycle sends an enqueued prompt immediately", () => {
  const result = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    canonicalLifecycle("settled", 1)
  );
  assert.equal(result.commands[0]?.type, "queue/sendPrompt");
  assert.deepEqual(
    send(result.commands[0]).submitDiagnostics,
    submitDiagnostics
  );
});

test("queued capability settings and diagnostics survive delivery", () => {
  const queued = reduce(
    createInitialPromptQueueState(),
    {
      ...submit("prompt-capability"),
      requiredSettingsPatch: { computerUse: true }
    },
    canonicalLifecycle("running", 1)
  );
  assert.deepEqual(
    queued.state.recordsBySessionId["session-1"]?.prompts[0]
      ?.requiredSettingsPatch,
    { computerUse: true }
  );
  const sending = reduce(
    queued.state,
    turnUpserted(settledTurn("turn-1", 2)),
    canonicalLifecycle("settled", 2)
  );
  assert.deepEqual(send(sending.commands[0]).requiredSettingsPatch, {
    computerUse: true
  });
});

test("immediate submit bypasses queue storage and preserves diagnostics", () => {
  const result = reduce(
    createInitialPromptQueueState(),
    { ...submit("prompt-immediate"), routing: "immediate" },
    canonicalLifecycle("settled", 1)
  );
  assert.equal(result.state.recordsBySessionId["session-1"], undefined);
  assert.deepEqual(
    send(result.commands[0]).submitDiagnostics,
    submitDiagnostics
  );
});

test("send-now native guidance can send against a canonical active turn", () => {
  const lifecycle = canonicalLifecycle("running", 1);
  let state = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-guidance"),
    lifecycle
  ).state;
  const guided = reduce(state, sendNow("prompt-guidance"), lifecycle);
  assert.equal(send(guided.commands[0]).guidance, true);
});

test("cancel-then-send waits until validated cancellation updates canonical lifecycle", () => {
  const running = canonicalLifecycle("running", 1);
  let state = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    running
  ).state;
  const promoted = reduce(state, sendNow("prompt-1"), running, {
    strategy: "cancel_then_send"
  });
  assert.deepEqual(promoted.commands, []);
  assert.equal(
    promoted.state.recordsBySessionId["session-1"]?.sendNextPromptId,
    "prompt-1"
  );

  const turn = settledTurn("turn-1", 2, "canceled");
  const validation: CancelResultValidation = {
    kind: "valid",
    response: {
      cancel: { canceled: true, reason: "turn_canceled" },
      turn: { ...turn, completedCommand: null, error: null, fileChanges: null }
    }
  };
  const canceled = reduce(
    promoted.state,
    commandResult("cancel-1", "turn/cancel", "succeeded"),
    canonicalLifecycle("settled", 2),
    { cancelValidation: validation }
  );
  assert.equal(canceled.commands[0]?.type, "queue/sendPrompt");
  assert.equal(send(canceled.commands[0]).guidance, undefined);
});

test("successful send establishes an exact-turn barrier before the next prompt", () => {
  const available = canonicalLifecycle("settled", 1, "turn-0");
  const first = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    available
  );
  let state = reduce(first.state, enqueue("prompt-2"), available).state;
  const running = canonicalLifecycle("running", 2, "turn-1");
  const accepted = reduce(
    state,
    commandResult(
      commandId(first.commands[0]),
      "queue/sendPrompt",
      "succeeded"
    ),
    running,
    { sendValidation: validSend("turn-1", "running", 2) }
  );
  assert.deepEqual(accepted.commands, []);
  assert.equal(
    accepted.state.recordsBySessionId["session-1"]?.deliveryBarrierTurnId,
    "turn-1"
  );

  const settled = reduce(
    accepted.state,
    turnUpserted(settledTurn("turn-1", 3)),
    canonicalLifecycle("settled", 3, "turn-1")
  );
  assert.equal(send(settled.commands[0]).promptId, "prompt-2");
});

test("turnless goal control result completes delivery without a turn barrier", () => {
  const available = canonicalLifecycle("settled", 1, "turn-0");
  const first = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    available
  );
  const withSecond = reduce(first.state, enqueue("prompt-2"), available).state;
  const completed = reduce(
    withSecond,
    commandResult(
      commandId(first.commands[0]),
      "queue/sendPrompt",
      "succeeded"
    ),
    available,
    {
      sendValidation: {
        kind: "valid",
        result: {
          kind: "goalControl",
          session: activitySession("settled", 2, "turn-0")
        }
      }
    }
  );
  assert.equal(send(completed.commands[0]).promptId, "prompt-2");
  assert.equal(
    completed.state.recordsBySessionId["session-1"]?.deliveryBarrierTurnId,
    null
  );
});

test("late send result drains once when its exact canonical turn already settled", () => {
  const available = canonicalLifecycle("settled", 1, "turn-0");
  const first = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    available
  );
  const withSecond = reduce(first.state, enqueue("prompt-2"), available).state;
  const completed = reduce(
    withSecond,
    commandResult(
      commandId(first.commands[0]),
      "queue/sendPrompt",
      "succeeded"
    ),
    canonicalLifecycle("settled", 3, "turn-1"),
    { sendValidation: validSend("turn-1", "running", 2) }
  );
  assert.equal(send(completed.commands[0]).promptId, "prompt-2");
});

test("pending canonical interaction blocks drain even after the turn settles", () => {
  const lifecycle = canonicalLifecycle("settled", 2, "turn-1", true);
  const queued = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    lifecycle
  );
  assert.deepEqual(queued.commands, []);
  assert.deepEqual(deriveCanonicalSubmitAvailability(lifecycle, "session-1"), {
    state: "blocked",
    reason: "waiting"
  });
});

test("user stop suspension blocks drain until explicit resume", () => {
  const running = canonicalLifecycle("running", 1);
  let state = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    running
  ).state;
  state = reduce(
    state,
    {
      agentSessionId: "session-1",
      awaitingTurnExpiresAtUnixMs: 30_000,
      commandId: "stop-1",
      type: "session/stopRequested",
      workspaceId: "workspace-1"
    },
    running
  ).state;
  const settled = canonicalLifecycle("settled", 2);
  state = reduce(state, turnUpserted(settledTurn("turn-1", 2)), settled).state;
  const resumed = reduce(
    state,
    { type: "queue/resumed", agentSessionId: "session-1" },
    settled
  );
  assert.equal(resumed.commands[0]?.type, "queue/sendPrompt");
});

test("ordinary submit resumes a paused queue and preserves FIFO", () => {
  const available = canonicalLifecycle("settled", 2);
  let state = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    canonicalLifecycle("running", 1)
  ).state;
  state = reduce(
    state,
    {
      type: "queue/suspended",
      agentSessionId: "session-1",
      reason: "user_stop"
    },
    canonicalLifecycle("running", 1)
  ).state;
  const submitted = reduce(state, submit("prompt-2"), available);
  assert.equal(send(submitted.commands[0]).promptId, "prompt-1");
  assert.deepEqual(
    submitted.state.recordsBySessionId["session-1"]?.prompts.map(
      (prompt) => prompt.id
    ),
    ["prompt-1", "prompt-2"]
  );
});

test("send failure stays blocked until send-now retry clears it", () => {
  const available = canonicalLifecycle("settled", 1);
  const sending = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    available
  );
  const failed = reduce(
    sending.state,
    commandResult(commandId(sending.commands[0]), "queue/sendPrompt", "failed"),
    available
  );
  assert.equal(
    failed.state.recordsBySessionId["session-1"]?.failedPromptId,
    "prompt-1"
  );
  const retried = reduce(failed.state, sendNow("prompt-1"), available);
  assert.equal(retried.commands[0]?.type, "queue/sendPrompt");
});

test("timeout confirmation waits for its exact canonical turn to settle", () => {
  const available = canonicalLifecycle("settled", 1, "turn-0");
  const first = reduce(
    createInitialPromptQueueState(),
    submit("prompt-1"),
    available
  );
  let state = reduce(first.state, enqueue("prompt-2"), available).state;
  const timedOut = reduce(
    state,
    commandResult(commandId(first.commands[0]), "queue/sendPrompt", "timedOut"),
    available
  );
  assert.equal(timedOut.commands[0]?.type, "session/reconcile");
  assert.equal(
    timedOut.state.recordsBySessionId["session-1"]?.uncertainDelivery?.promptId,
    "prompt-1"
  );

  const confirmedBeforeTurn = reduce(
    timedOut.state,
    messagesReceived("prompt-1", "turn-1"),
    available
  );
  assert.deepEqual(confirmedBeforeTurn.commands, []);
  assert.equal(
    confirmedBeforeTurn.state.recordsBySessionId["session-1"]
      ?.deliveryBarrierTurnId,
    "turn-1"
  );
  assert.equal(
    confirmedBeforeTurn.state.recordsBySessionId["session-1"]
      ?.uncertainDelivery,
    null
  );

  const running = reduce(
    confirmedBeforeTurn.state,
    turnUpserted(runningTurn("turn-1", 2)),
    canonicalLifecycle("running", 2, "turn-1")
  );
  assert.deepEqual(running.commands, []);
  const settled = reduce(
    running.state,
    turnUpserted(settledTurn("turn-1", 3)),
    canonicalLifecycle("settled", 3, "turn-1")
  );
  assert.equal(send(settled.commands[0]).promptId, "prompt-2");
});

test("confirmation without exact turn id stays uncertain across expiry", () => {
  const available = canonicalLifecycle("settled", 1);
  const sending = reduce(
    createInitialPromptQueueState(),
    submit("prompt-1"),
    available
  );
  const timedOut = reduce(
    sending.state,
    commandResult(
      commandId(sending.commands[0]),
      "queue/sendPrompt",
      "timedOut"
    ),
    available
  );
  const uncorrelated = reduce(
    timedOut.state,
    messagesReceived("prompt-1", null),
    available
  );
  assert.equal(
    uncorrelated.state.recordsBySessionId["session-1"]?.uncertainDelivery
      ?.promptId,
    "prompt-1"
  );
  const expired = reduce(
    uncorrelated.state,
    {
      type: "engine/intentExpired",
      expiryId: "submit:prompt-1",
      dueAtUnixMs: 60_000
    },
    available
  );
  assert.equal(
    expired.state.recordsBySessionId["session-1"]?.uncertainDelivery?.promptId,
    "prompt-1"
  );
});

test("session removal cleans queue-owned delivery state", () => {
  const lifecycle = canonicalLifecycle("running", 1);
  const queued = reduce(
    createInitialPromptQueueState(),
    enqueue("prompt-1"),
    lifecycle
  );
  const removed = reduce(
    queued.state,
    { type: "session/removed", agentSessionId: "session-1" },
    createInitialSessionLifecycleState(),
    { deletedSessionIds: { "session-1": true } }
  );
  assert.equal(removed.state.recordsBySessionId["session-1"], undefined);
});

function reduce(
  state: ReturnType<typeof createInitialPromptQueueState>,
  intent: Parameters<typeof promptQueueReducer>[1],
  lifecycle: SessionLifecycleState,
  options: {
    cancelValidation?: CancelResultValidation;
    deletedSessionIds?: Readonly<Record<string, true>>;
    sendValidation?: SendInputResultValidation;
    strategy?: PromptQueueSendNowStrategy;
  } = {}
) {
  const availability = deriveCanonicalSubmitAvailability(
    lifecycle,
    "session-1"
  );
  const strategy =
    options.strategy ??
    (intent.type === "submit/requested" && intent.routing === "send_now"
      ? resolvePromptSendNowStrategy(availability, {
          activeTurnGuidance: true,
          interrupt: true
        })
      : intent.type === "queue/sendNowRequested"
        ? resolveQueuedPromptSendNowStrategy(
            state,
            intent.agentSessionId,
            intent.promptId,
            availability,
            { activeTurnGuidance: true, interrupt: true }
          )
        : null);
  return promptQueueReducer(state, intent, {
    cancelResultValidation: options.cancelValidation,
    deletedSessionIds: options.deletedSessionIds ?? {},
    lifecycle,
    sendNowStrategy: strategy,
    sendResultValidation: options.sendValidation,
    submitRequestAccepted: true
  });
}

function canonicalLifecycle(
  phase: "running" | "settled",
  updatedAtUnixMs: number,
  turnId = "turn-1",
  pendingInteraction = false
): SessionLifecycleState {
  return sessionLifecycleReducer(createInitialSessionLifecycleState(), {
    type: "session/snapshotReceived",
    sessions: [
      activitySession(phase, updatedAtUnixMs, turnId, pendingInteraction)
    ]
  }).state;
}

function activitySession(
  phase: "running" | "settled",
  updatedAtUnixMs: number,
  turnId: string,
  pendingInteraction = false
): AgentActivitySession {
  const turn =
    phase === "running"
      ? runningTurn(turnId, updatedAtUnixMs)
      : settledTurn(turnId, updatedAtUnixMs);
  const interaction: AgentActivityInteraction = {
    agentSessionId: "session-1",
    createdAtUnixMs: updatedAtUnixMs,
    input: {},
    kind: "question",
    metadata: {},
    requestId: "request-1",
    status: "pending",
    turnId,
    updatedAtUnixMs
  };
  return normalizeAgentActivitySession({
    activeTurn: phase === "running" ? turn : null,
    activeTurnId: phase === "running" ? turnId : null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    latestTurn: turn,
    latestTurnInteractions: pendingInteraction ? [interaction] : [],
    pendingInteractions: pendingInteraction ? [interaction] : [],
    provider: "codex",
    title: "Session",
    updatedAtUnixMs,
    workspaceId: "workspace-1"
  });
}

function validSend(
  turnId: string,
  phase: "running" | "settled",
  updatedAtUnixMs: number
): SendInputResultValidation {
  const session = activitySession(phase, updatedAtUnixMs, turnId);
  return {
    kind: "valid",
    result: { session, turn: session.latestTurn!, turnId }
  };
}

function runningTurn(
  turnId: string,
  updatedAtUnixMs: number
): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    origin: "user_prompt",
    phase: "running",
    startedAtUnixMs: updatedAtUnixMs,
    turnId,
    updatedAtUnixMs
  };
}

function settledTurn(
  turnId: string,
  updatedAtUnixMs: number,
  outcome: "completed" | "canceled" = "completed"
): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    origin: "user_prompt",
    outcome,
    phase: "settled",
    settledAtUnixMs: updatedAtUnixMs,
    startedAtUnixMs: Math.max(0, updatedAtUnixMs - 1),
    turnId,
    updatedAtUnixMs
  };
}

function turnUpserted(turn: AgentActivityTurn) {
  return { type: "turn/upserted" as const, turn };
}

function messagesReceived(clientSubmitId: string, turnId: string | null) {
  return {
    type: "message/snapshotReceived" as const,
    messages: [
      {
        agentSessionId: "session-1",
        kind: "text",
        messageId: "message-1",
        occurredAtUnixMs: 4,
        payload: { clientSubmitId, text: clientSubmitId },
        role: "user",
        turnId,
        version: 1
      }
    ]
  };
}

function sendNow(promptId: string) {
  return {
    type: "queue/sendNowRequested" as const,
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    cancelCommandId: "cancel-1",
    promptId,
    timeoutMs: 30_000
  };
}

function enqueue(promptId: string) {
  return {
    type: "queue/enqueued" as const,
    agentSessionId: "session-1",
    prompt: {
      id: promptId,
      content: [{ type: "text" as const, text: promptId }],
      createdAtUnixMs: 1,
      submitDiagnostics
    },
    workspaceId: "workspace-1"
  };
}

function submit(clientSubmitId: string) {
  return {
    type: "submit/requested" as const,
    agentSessionId: "session-1",
    clientSubmitId,
    content: [{ type: "text" as const, text: clientSubmitId }],
    expiresAtUnixMs: 60_000,
    requestedAtUnixMs: 1,
    submitDiagnostics,
    workspaceId: "workspace-1"
  };
}

const submitDiagnostics = {
  blockCount: 1,
  hasImage: false,
  promptLength: 8,
  queued: false,
  source: "agent-gui",
  submittedAtUnixMs: 1
} as const;

function commandResult(
  commandId: string,
  commandType: EngineCommandResultIntent["commandType"],
  outcome: EngineCommandResultIntent["outcome"]
): EngineCommandResultIntent {
  return { type: "engine/commandResult", commandId, commandType, outcome };
}

function commandId(command: EngineCommand | undefined): string {
  assert.ok(command && "commandId" in command && command.commandId);
  return command.commandId;
}

function send(
  command: EngineCommand | undefined
): Extract<EngineCommand, { type: "queue/sendPrompt" }> {
  assert.equal(command?.type, "queue/sendPrompt");
  return command as Extract<EngineCommand, { type: "queue/sendPrompt" }>;
}
