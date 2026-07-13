import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivitySession } from "../types.ts";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import {
  createInitialPromptQueueState,
  promptQueueReducer
} from "./promptQueue.reducer.ts";
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

test("stale snapshots and stale cancel results cannot release a newer running turn", () => {
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
  state = reduce(staleSnapshot.state, {
    type: "queue/promoted",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    cancelCommandId: "cancel-1",
    promptId: "prompt-1",
    timeoutMs: 30_000
  }).state;
  const staleCancel = reduce(state, {
    ...commandResult("cancel-1", "turn/cancel", "succeeded"),
    value: {
      cancel: { canceled: true, reason: "turn_canceled" as const },
      turn: {
        ...session("running", 2).activeTurn!,
        phase: "settled",
        outcome: "canceled"
      }
    }
  });
  assert.equal(staleCancel.commands.length, 0);
  assert.equal(
    staleCancel.state.recordsBySessionId["session-1"]?.availability.state,
    "blocked"
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

test("promoting a prompt while busy cancels once then sends after cancellation", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  state = reduce(state, enqueue("prompt-2")).state;

  const promoted = reduce(state, {
    type: "queue/promoted",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    cancelCommandId: "cancel-1",
    promptId: "prompt-2",
    timeoutMs: 30_000
  });
  assert.equal(promoted.commands.length, 0);
  assert.deepEqual(
    promoted.state.recordsBySessionId["session-1"]?.prompts.map(
      (prompt) => prompt.id
    ),
    ["prompt-2", "prompt-1"]
  );

  const settledSnapshot = reduce(promoted.state, {
    type: "session/snapshotReceived",
    sessions: [session("settled", 2)]
  });
  assert.equal(settledSnapshot.commands[0]?.type, "queue/sendPrompt");
  assert.deepEqual(
    settledSnapshot.commands[0]?.type === "queue/sendPrompt"
      ? settledSnapshot.commands[0].submitDiagnostics
      : null,
    submitDiagnostics
  );
});

test("cancel result can release send-next without waiting for snapshot ordering", () => {
  let state = reduce(createInitialPromptQueueState(), {
    type: "session/snapshotReceived",
    sessions: [session("running", 1)]
  }).state;
  state = reduce(state, enqueue("prompt-1")).state;
  const promoted = reduce(state, {
    type: "queue/promoted",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    cancelCommandId: "cancel-1",
    promptId: "prompt-1",
    timeoutMs: 30_000
  });
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
    deletedSessionIds: {},
    cancelResultValidation: {
      kind: "valid",
      response: cancelIntent.value
    }
  });
  assert.equal(canceled.commands.length, 1);
  assert.equal(canceled.commands[0]?.type, "queue/sendPrompt");
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

  const retried = reduce(sameVersion.state, {
    type: "queue/promoted",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    cancelCommandId: "cancel-1",
    promptId: "prompt-1",
    timeoutMs: 30_000
  });
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
  const retried = reduce(failed.state, {
    type: "queue/promoted",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    cancelCommandId: "cancel-1",
    promptId: "prompt-1",
    timeoutMs: 30_000
  });
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
  const retryBlocked = reduce(timedOut.state, {
    type: "queue/promoted",
    agentSessionId: "session-1",
    awaitingTurnExpiresAtUnixMs: 30_000,
    cancelCommandId: "cancel-1",
    promptId: "prompt-1",
    timeoutMs: 30_000
  });
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
  intent: Parameters<typeof promptQueueReducer>[1]
) {
  return promptQueueReducer(state, intent);
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
    agentSessionId: "session-1",
    cwd: "/workspace",
    provider: "codex",
    activeTurnId: phase === "running" ? "turn-1" : null,
    activeTurn:
      phase === "running"
        ? {
            turnId: "turn-1",
            agentSessionId: "session-1",
            phase,
            startedAtUnixMs: 1,
            updatedAtUnixMs
          }
        : null,
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
