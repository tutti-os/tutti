import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import { dispatchSessionMutation } from "./sessionMutationDispatch.ts";
import {
  createInitialSessionMutationsState,
  sessionMutationsReducer
} from "./sessionMutations.reducer.ts";
import type { AgentSessionEngineState, EngineCommandPort } from "./types.ts";

const session = normalizeAgentActivitySession({
  activeTurnId: null,
  agentSessionId: "session-1",
  agentTargetId: "local:codex",
  cwd: "/workspace",
  latestTurnInteractions: [],
  pendingInteractions: [],
  provider: "codex",
  railSectionKey: "conversations",
  title: "Session",
  updatedAtUnixMs: 1,
  workspaceId: "workspace-1"
});

test("pin result commits mutation and canonical session in one engine notification", async () => {
  let resolveCommand: (value: unknown) => void = () => {};
  const commandPort: EngineCommandPort = {
    execute: async () =>
      new Promise((resolve) => {
        resolveCommand = resolve;
      })
  };
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 0 },
    commandPort,
    identity: { origin: "local", workspaceId: "workspace-1" },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
  engine.dispatch({ session, type: "session/upserted" });
  const states: AgentSessionEngineState[] = [];
  engine.subscribe((state) => states.push(state));

  const resultPromise = dispatchSessionMutation(engine, {
    agentSessionId: "session-1",
    mutationId: "pin-1",
    pinned: true,
    type: "session/pinRequested",
    workspaceId: "workspace-1"
  });
  assert.equal(states.length, 1);
  assert.equal(
    states[0]?.sessionMutations.byMutationId["pin-1"]?.status,
    "inFlight"
  );
  assert.equal(
    states[0]?.sessionLifecycle.sessionsById["session-1"]?.pinnedAtUnixMs,
    null
  );

  resolveCommand({
    session: { ...session, pinnedAtUnixMs: 10, updatedAtUnixMs: 2 }
  });
  await resultPromise;

  assert.equal(states.length, 2);
  assert.equal(
    states[1]?.sessionMutations.byMutationId["pin-1"]?.status,
    "succeeded"
  );
  assert.equal(
    states[1]?.sessionLifecycle.sessionsById["session-1"]?.pinnedAtUnixMs,
    10
  );
  assert.equal(
    states.some(
      (state) =>
        state.sessionMutations.byMutationId["pin-1"]?.status === "succeeded" &&
        state.sessionLifecycle.sessionsById["session-1"]?.pinnedAtUnixMs == null
    ),
    false
  );
  engine.dispose();
});

test("failed mutation is explicit and emits no canonical follow-up", () => {
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      agentSessionId: "session-1",
      mutationId: "pin-1",
      pinned: true,
      type: "session/pinRequested",
      workspaceId: "workspace-1"
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );
  const failed = sessionMutationsReducer(
    requested.state,
    {
      commandId: "pin-1",
      commandType: "session/setPinned",
      correlationId: "pin-1",
      errorMessage: "transport failed",
      outcome: "failed",
      type: "engine/commandResult"
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );

  assert.equal(failed.state.byMutationId["pin-1"]?.status, "failed");
  assert.deepEqual(failed.followUpIntents, undefined);
});

test("delete result emits removals for requested and cascaded sessions", () => {
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      agentSessionIds: ["session-1"],
      mutationId: "delete-1",
      type: "sessions/deleteRequested",
      workspaceId: "workspace-1"
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );
  const succeeded = sessionMutationsReducer(
    requested.state,
    {
      commandId: "delete-1",
      commandType: "sessions/delete",
      correlationId: "delete-1",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: {
        cleanupFailedSessionIds: [],
        removedMessages: 2,
        removedSessionIds: ["session-1", "child-1"],
        removedSessions: 2
      }
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );

  assert.deepEqual(succeeded.followUpIntents, [
    { agentSessionId: "session-1", type: "session/removed" },
    { agentSessionId: "child-1", type: "session/removed" }
  ]);
});

test("settled mutation history stays bounded across unique sessions", () => {
  let state = createInitialSessionMutationsState();
  for (let index = 0; index < 200; index += 1) {
    const mutationId = `delete-${index}`;
    const agentSessionId = `session-${index}`;
    state = sessionMutationsReducer(
      state,
      {
        agentSessionIds: [agentSessionId],
        mutationId,
        type: "sessions/deleteRequested",
        workspaceId: "workspace-1"
      },
      { deletedSessionIds: {}, sessionsById: {} }
    ).state;
    state = sessionMutationsReducer(
      state,
      {
        commandId: mutationId,
        commandType: "sessions/delete",
        correlationId: mutationId,
        outcome: "succeeded",
        type: "engine/commandResult",
        value: {
          cleanupFailedSessionIds: [],
          removedMessages: 0,
          removedSessionIds: [agentSessionId],
          removedSessions: 1
        }
      },
      { deletedSessionIds: {}, sessionsById: {} }
    ).state;
  }

  assert.equal(Object.keys(state.byMutationId).length, 128);
  assert.equal(state.byMutationId["delete-199"]?.status, "succeeded");
  assert.equal(state.byMutationId["delete-0"], undefined);
});
