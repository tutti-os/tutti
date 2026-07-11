import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialPendingIntentsState,
  pendingIntentsReducer
} from "./pendingIntents.reducer.ts";

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
      submitAvailability: { state: "blocked" },
      turnId: "turn-1",
      turnLifecycle: { activeTurnId: "turn-1", phase: "running" }
    }
  }).state;
  assert.equal(state.submitsByClientSubmitId["submit-1"]?.turnId, "turn-1");
  assert.equal(state.submitsByClientSubmitId["submit-1"]?.status, "accepted");
});

test("activation intent owns the transport command and confirmation deadline", () => {
  const result = reduce(createInitialPendingIntentsState(), activation());
  assert.equal(
    result.state.activationsByRequestId["activation-1"]?.status,
    "requested"
  );
  assert.deepEqual(result.commands, [
    {
      dueAtUnixMs: 120_000,
      expiryId: "activation:activation-1",
      type: "engine/scheduleExpiry"
    },
    {
      agentSessionId: "session-new",
      agentTargetId: "target-1",
      commandId: "activate:activation-1",
      correlationId: "activation-1",
      cwd: "/workspace",
      initialContent: [{ type: "text", text: "hello" }],
      metadata: { clientSubmitId: "submit-new" },
      mode: "new",
      settings: { model: "model-1" },
      timeoutMs: 30_000,
      title: "New session",
      type: "session/activate",
      workspaceId: "workspace-1"
    }
  ]);
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
    metadata: { clientSubmitId: "submit-new" },
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
    agentSessionId,
    cwd: "/workspace",
    provider: "codex",
    status: "ready",
    title: "Session",
    workspaceId: "workspace-1"
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
  return pendingIntentsReducer(state, intent);
}
