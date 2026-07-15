import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivitySession } from "../types.ts";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import {
  createInitialPromptQueueState,
  promptQueueReducer
} from "./promptQueue.reducer.ts";
import {
  resolvePromptSendNowStrategy,
  resolveQueuedPromptSendNowStrategy,
  type PromptQueueSendNowStrategy
} from "./promptQueue.sendNow.ts";
import type { EngineCommand, EngineCommandResultIntent } from "./types.ts";

test("queued prompt waits for a busy turn and sends when canonical lifecycle settles", () => {
  let state = createInitialPromptQueueState();
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  }).state;

  const queued = reduce(state, enqueue("prompt-1"));
  assert.equal(queued.commands.length, 0);
  assert.deepEqual(
    queued.state.recordsBySessionId["session-1"]?.prompts.map(
      (prompt) => prompt.id
    ),
    ["prompt-1"]
  );

  const settled = reduce(queued.state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 2)]
  });
  assert.equal(settled.commands[0]?.type, "queue/sendPrompt");
  assert.equal(settled.commands[0]?.commandId, "queue:send:session-1:1");
});

test("queued capability submit preserves its required settings through delivery", () => {
  const loaded = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  });
  const queued = reduce(loaded.state, {
    ...submit("prompt-capability"),
    requiredSettingsPatch: { computerUse: true }
  });

  assert.equal(queued.commands.length, 0);
  assert.deepEqual(
    queued.state.recordsBySessionId["session-1"]?.prompts[0]
      ?.requiredSettingsPatch,
    { computerUse: true }
  );

  const settled = reduce(queued.state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 2)]
  });
  assert.deepEqual(
    settled.commands[0]?.type === "queue/sendPrompt"
      ? settled.commands[0].requiredSettingsPatch
      : null,
    { computerUse: true }
  );

  const failed = reduce(
    settled.state,
    commandResult(commandId(settled.commands[0]), "queue/sendPrompt", "failed")
  );
  const retried = reduce(failed.state, sendNow("prompt-capability"));
  assert.deepEqual(
    retried.commands[0]?.type === "queue/sendPrompt"
      ? retried.commands[0].requiredSettingsPatch
      : null,
    { computerUse: true }
  );
});

test("enqueue drains immediately against the engine's available snapshot", () => {
  const loaded = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("settled", 1)]
  });
  const queued = reduce(loaded.state, enqueue("prompt-1"));
  assert.equal(queued.commands[0]?.type, "queue/sendPrompt");
  assert.deepEqual(
    queued.commands[0]?.type === "queue/sendPrompt"
      ? queued.commands[0].submitDiagnostics
      : null,
    submitDiagnostics
  );
});

test("immediate submit preserves diagnostics on the send command", () => {
  const result = reduce(createInitialPromptQueueState(), {
    ...submit("prompt-immediate"),
    routing: "immediate"
  });
  assert.deepEqual(
    result.commands[0]?.type === "queue/sendPrompt"
      ? result.commands[0].submitDiagnostics
      : null,
    submitDiagnostics
  );
});

test("send-now submit atomically becomes native guidance for a capable active turn", () => {
  const loaded = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  });
  const result = reduce(loaded.state, {
    ...submit("prompt-guidance"),
    routing: "send_now"
  });
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]?.type, "queue/sendPrompt");
  assert.equal(
    result.commands[0]?.type === "queue/sendPrompt"
      ? result.commands[0].guidance
      : undefined,
    true
  );
});

test("send-now submit stays queued for cancel-then-send fallback", () => {
  const loaded = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  });
  const result = reduce(
    loaded.state,
    { ...submit("prompt-fallback"), routing: "send_now" },
    "cancel_then_send"
  );
  assert.equal(result.commands.length, 0);
  assert.equal(
    result.state.recordsBySessionId["session-1"]?.sendNextPromptId,
    "prompt-fallback"
  );
  assert.equal(
    result.state.recordsBySessionId["session-1"]?.prompts[0]?.guidance,
    undefined
  );
});

test("successful send removes only the claimed head and waits for another lifecycle update", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("settled", 1)]
  }).state;
  const first = reduce(state, enqueue("prompt-1"));
  state = first.state;
  state = reduce(state, enqueue("prompt-2")).state;

  const completed = reduce(
    state,
    commandResult(commandId(first.commands[0]), "queue/sendPrompt", "succeeded")
  );
  assert.equal(completed.commands.length, 0);
  assert.deepEqual(
    completed.state.recordsBySessionId["session-1"]?.prompts.map(
      (prompt) => prompt.id
    ),
    ["prompt-2"]
  );
});

test("late send result starts the next prompt after a complete observed turn", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("settled", 1)]
  }).state;
  const first = reduce(state, enqueue("prompt-1"));
  assert.equal(
    "timeoutMs" in first.commands[0]! ? first.commands[0]!.timeoutMs : null,
    30_000
  );
  state = reduce(first.state, enqueue("prompt-2")).state;
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("running", 2)]
  }).state;
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 3)]
  }).state;

  const completed = reduce(
    state,
    commandResult(commandId(first.commands[0]), "queue/sendPrompt", "succeeded")
  );
  assert.equal(completed.commands[0]?.type, "queue/sendPrompt");
  assert.equal(
    completed.state.recordsBySessionId["session-1"]?.inFlight?.promptId,
    "prompt-2"
  );
});

test("metadata-only session updates do not prove a queued turn completed", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("settled", 1)]
  }).state;
  const first = reduce(state, enqueue("prompt-1"));
  state = reduce(first.state, enqueue("prompt-2")).state;
  const metadataOnly = {
    ...session("settled", 2),
    activeTurn: session("settled", 1).activeTurn
  };
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [metadataOnly]
  }).state;
  const completed = reduce(
    state,
    commandResult(commandId(first.commands[0]), "queue/sendPrompt", "succeeded")
  );
  assert.equal(completed.commands.length, 0);
  assert.equal(completed.state.recordsBySessionId["session-1"]?.inFlight, null);
});

test("Claude goal completion does not drain prompts while the canonical root waits", () => {
  const running = session("running", 1);
  const waiting = {
    ...running,
    activeTurn: { ...running.activeTurn!, phase: "waiting" as const },
    goal: { objective: "ship it", status: "active" as const },
    provider: "claude-code"
  };
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [waiting]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;

  const goalCompleted = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [
      {
        ...waiting,
        goal: { objective: "ship it", status: "complete" as const },
        updatedAtUnixMs: 2
      }
    ]
  });

  assert.equal(goalCompleted.commands.length, 0);
  assert.equal(
    goalCompleted.state.recordsBySessionId["session-1"]?.availability.state,
    "blocked"
  );
  assert.deepEqual(
    goalCompleted.state.recordsBySessionId["session-1"]?.prompts.map(
      (prompt) => prompt.id
    ),
    ["prompt-1"]
  );
});

test("native guidance uses the current running turn despite a stale settled snapshot", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 3)]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  const staleSnapshot = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 2)]
  });
  assert.equal(staleSnapshot.commands.length, 0);
  assert.equal(
    staleSnapshot.state.recordsBySessionId["session-1"]?.availability.state,
    "blocked"
  );
  const guided = reduce(staleSnapshot.state, sendNow("prompt-1"));
  assert.equal(guided.commands[0]?.type, "queue/sendPrompt");
  assert.equal(
    guided.commands[0]?.type === "queue/sendPrompt"
      ? guided.commands[0].guidance
      : false,
    true
  );
});

test("user stop suspends automatic drain until an explicit resume", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  state = reduce(state, {
    type: "queue/suspended",
    agentSessionId: "session-1",
    reason: "user_stop"
  }).state;
  const settled = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 2)]
  });
  assert.equal(settled.commands.length, 0);

  const resumed = reduce(settled.state, {
    type: "queue/resumed",
    agentSessionId: "session-1"
  });
  assert.equal(resumed.commands[0]?.type, "queue/sendPrompt");
});

test("ordinary submit resumes a paused queue without losing the existing FIFO head command", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  state = reduce(state, enqueue("prompt-2")).state;
  state = reduce(state, {
    type: "queue/suspended",
    agentSessionId: "session-1",
    reason: "user_stop"
  }).state;
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 2)]
  }).state;

  const submitted = reduce(state, submit("prompt-3"));

  assert.equal(submitted.commands.length, 1);
  assert.equal(submitted.commands[0]?.type, "queue/sendPrompt");
  assert.equal(
    submitted.commands[0]?.type === "queue/sendPrompt"
      ? submitted.commands[0].promptId
      : null,
    "prompt-1"
  );
  assert.deepEqual(
    submitted.state.recordsBySessionId["session-1"]?.prompts.map(
      (prompt) => prompt.id
    ),
    ["prompt-1", "prompt-2", "prompt-3"]
  );
  assert.equal(
    submitted.state.recordsBySessionId["session-1"]?.inFlight?.promptId,
    "prompt-1"
  );
  assert.equal(
    submitted.state.recordsBySessionId["session-1"]?.suspendReason,
    null
  );
});

test("ordinary submit only resumes and enqueues until the interrupted turn settles", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  state = reduce(state, {
    type: "queue/suspended",
    agentSessionId: "session-1",
    reason: "user_stop"
  }).state;

  const submitted = reduce(state, submit("prompt-2"));

  assert.equal(submitted.commands.length, 0);
  assert.equal(
    submitted.state.recordsBySessionId["session-1"]?.suspendReason,
    null
  );
  assert.deepEqual(
    submitted.state.recordsBySessionId["session-1"]?.prompts.map(
      (prompt) => prompt.id
    ),
    ["prompt-1", "prompt-2"]
  );

  const settled = reduce(submitted.state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 2)]
  });
  assert.equal(settled.commands.length, 1);
  assert.equal(
    settled.commands[0]?.type === "queue/sendPrompt"
      ? settled.commands[0].promptId
      : null,
    "prompt-1"
  );
});

test("send now resumes a paused queue and emits only the promoted prompt command", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  state = reduce(state, enqueue("prompt-2")).state;
  state = reduce(state, {
    type: "queue/suspended",
    agentSessionId: "session-1",
    reason: "user_stop"
  }).state;
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 2)]
  }).state;

  const promoted = reduce(state, sendNow("prompt-2"));

  assert.equal(promoted.commands.length, 1);
  assert.equal(
    promoted.commands[0]?.type === "queue/sendPrompt"
      ? promoted.commands[0].promptId
      : null,
    "prompt-2"
  );
  assert.deepEqual(
    promoted.state.recordsBySessionId["session-1"]?.prompts.map(
      (prompt) => prompt.id
    ),
    ["prompt-2", "prompt-1"]
  );
  assert.equal(
    promoted.state.recordsBySessionId["session-1"]?.suspendReason,
    null
  );
});

test("send now uses native guidance without cancel when the provider supports it", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  state = reduce(state, enqueue("prompt-2")).state;

  const promoted = reduce(state, sendNow("prompt-2"));
  assert.equal(promoted.commands[0]?.type, "queue/sendPrompt");
  assert.equal(
    promoted.commands[0]?.type === "queue/sendPrompt"
      ? promoted.commands[0].guidance
      : false,
    true
  );
  assert.deepEqual(
    promoted.state.recordsBySessionId["session-1"]?.prompts.map(
      (prompt) => prompt.id
    ),
    ["prompt-2", "prompt-1"]
  );

  assert.deepEqual(
    promoted.commands[0]?.type === "queue/sendPrompt"
      ? promoted.commands[0].submitDiagnostics
      : null,
    submitDiagnostics
  );
});

test("cancel-then-send fallback waits for cancellation before normal send", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  const promoted = reduce(state, sendNow("prompt-1"), "cancel_then_send");
  assert.equal(promoted.commands.length, 0);
  const cancelIntent = {
    ...commandResult("cancel-1", "turn/cancel", "succeeded"),
    value: {
      cancel: { canceled: true, reason: "turn_canceled" as const },
      turn: {
        ...session("running", 2).activeTurn!,
        completedCommand: null,
        error: null,
        fileChanges: null,
        phase: "settled" as const,
        outcome: "canceled" as const,
        settledAtUnixMs: 2,
        updatedAtUnixMs: 2
      }
    }
  };
  const canceled = promptQueueReducer(promoted.state, cancelIntent, {
    cancelResultValidation: {
      kind: "valid",
      response: cancelIntent.value
    },
    deletedSessionIds: {},
    sendNowStrategy: null
  });
  assert.equal(canceled.commands.length, 1);
  assert.equal(canceled.commands[0]?.type, "queue/sendPrompt");
  assert.equal(
    canceled.commands[0]?.type === "queue/sendPrompt"
      ? canceled.commands[0].guidance
      : undefined,
    undefined
  );
});

test("a full settled snapshot preserves the observed turn needed by a late send result", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("settled", 1)]
  }).state;
  const first = reduce(state, enqueue("prompt-1"));
  state = reduce(first.state, enqueue("prompt-2")).state;
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("running", 2)]
  }).state;
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 3)]
  }).state;
  const completed = reduce(
    state,
    commandResult(commandId(first.commands[0]), "queue/sendPrompt", "succeeded")
  );
  assert.equal(completed.commands[0]?.type, "queue/sendPrompt");
});

test("same-millisecond stale settled turn cannot replace a different running turn", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        ...session("running", 3),
        activeTurn: { ...session("running", 3).activeTurn!, turnId: "turn-b" },
        activeTurnId: "turn-b"
      }
    ]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  const stale = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        ...session("settled", 3),
        activeTurn: {
          ...session("running", 3).activeTurn!,
          phase: "settled",
          turnId: "turn-a"
        }
      }
    ]
  });
  assert.equal(stale.commands.length, 0);
  assert.equal(
    stale.state.recordsBySessionId["session-1"]?.availability.activeTurnId,
    "turn-b"
  );
});

test("send failure stays visible until the failed prompt is explicitly promoted", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("settled", 1)]
  }).state;
  const sending = reduce(state, enqueue("prompt-1"));
  const failed = reduce(sending.state, {
    ...commandResult(
      commandId(sending.commands[0]),
      "queue/sendPrompt",
      "failed"
    ),
    errorMessage: "Agent session already has an active turn"
  });
  assert.equal(
    failed.state.recordsBySessionId["session-1"]?.failedPromptId,
    "prompt-1"
  );

  const sameVersion = reduce(failed.state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 2)]
  });
  assert.equal(sameVersion.commands.length, 0);

  const retried = reduce(sameVersion.state, sendNow("prompt-1"));
  assert.equal(retried.commands[0]?.type, "queue/sendPrompt");
});

test("non-conflict send failure marks the head and promotion clears the failure", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("settled", 1)]
  }).state;
  const sending = reduce(state, enqueue("prompt-1"));
  const failed = reduce(
    sending.state,
    commandResult(commandId(sending.commands[0]), "queue/sendPrompt", "failed")
  );
  assert.equal(
    failed.state.recordsBySessionId["session-1"]?.failedPromptId,
    "prompt-1"
  );
  const retried = reduce(failed.state, sendNow("prompt-1"));
  assert.equal(retried.commands[0]?.type, "queue/sendPrompt");
});

test("send timeout is uncertain until a canonical turn proves acceptance", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("settled", 1)]
  }).state;
  const first = reduce(state, submit("prompt-1"));
  state = reduce(first.state, enqueue("prompt-2")).state;
  const timedOut = reduce(
    state,
    commandResult(commandId(first.commands[0]), "queue/sendPrompt", "timedOut")
  );
  assert.equal(timedOut.commands[0]?.type, "session/reconcile");
  assert.equal(
    timedOut.state.recordsBySessionId["session-1"]?.uncertainDelivery?.promptId,
    "prompt-1"
  );
  const retryBlocked = reduce(timedOut.state, sendNow("prompt-1"));
  assert.equal(retryBlocked.commands.length, 0);
  state = reduce(retryBlocked.state, {
    type: "session/snapshotReceived",
    sessions: [session("running", 2)]
  }).state;
  assert.equal(
    state.recordsBySessionId["session-1"]?.uncertainDelivery?.promptId,
    "prompt-1"
  );
  state = reduce(state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 3)]
  }).state;
  assert.equal(
    state.recordsBySessionId["session-1"]?.uncertainDelivery?.promptId,
    "prompt-1"
  );
  const confirmed = reduce(state, {
    type: "message/snapshotReceived",
    messages: [
      {
        agentSessionId: "session-1",
        kind: "text",
        messageId: "message-1",
        occurredAtUnixMs: 4,
        payload: { clientSubmitId: "prompt-1", text: "prompt-1" },
        role: "user",
        turnId: "turn-1",
        version: 1
      }
    ]
  });
  assert.equal(confirmed.commands[0]?.type, "queue/sendPrompt");
  assert.equal(
    confirmed.state.recordsBySessionId["session-1"]?.inFlight?.promptId,
    "prompt-2"
  );
});

function reduce(
  state: ReturnType<typeof createInitialPromptQueueState>,
  intent: Parameters<typeof promptQueueReducer>[1],
  strategy?: PromptQueueSendNowStrategy
) {
  return promptQueueReducer(state, intent, {
    deletedSessionIds: {},
    sendNowStrategy:
      intent.type === "submit/requested" && intent.routing === "send_now"
        ? (strategy ??
          resolvePromptSendNowStrategy(state, intent.agentSessionId, {
            activeTurnGuidance: true,
            interrupt: true
          }))
        : intent.type === "queue/sendNowRequested"
          ? (strategy ??
            resolveQueuedPromptSendNowStrategy(
              state,
              intent.agentSessionId,
              intent.promptId,
              { activeTurnGuidance: true, interrupt: true }
            ))
          : null
  });
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

function session(
  phase: "running" | "settled",
  updatedAtUnixMs: number
): AgentActivitySession {
  return normalizeAgentActivitySession({
    ...{
      activeTurnId: null,
      latestTurnInteractions: [],
      pendingInteractions: []
    },
    agentSessionId: "session-1",
    cwd: "/workspace",
    provider: "codex",
    activeTurnId: phase === "running" ? "turn-1" : null,
    activeTurn:
      phase === "running"
        ? {
            turnId: "turn-1",
            agentSessionId: "session-1",
            origin: "user_prompt",
            phase,
            startedAtUnixMs: 1,
            updatedAtUnixMs
          }
        : null,
    latestTurnInteractions: [],
    pendingInteractions: [],
    title: "Session",
    updatedAtUnixMs,
    workspaceId: "workspace-1"
  });
}

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
