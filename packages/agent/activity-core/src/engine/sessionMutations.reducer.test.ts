import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import {
  dispatchSessionForkThroughTurn,
  dispatchSessionMutationWithCancellation
} from "./sessionMutationDispatch.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";
import {
  createInitialSessionMutationsState,
  SESSION_FORK_OBSERVATION_ACK_RETRY_BACKOFF_MS,
  SESSION_FORK_OBSERVATION_ACK_TIMEOUT_MS,
  sessionMutationsReducer
} from "./sessionMutations.reducer.ts";
import {
  selectPendingSessionForkThroughTurnIds,
  selectSessionForkThroughTurnMutation
} from "./sessionMutations.selectors.ts";
import { createTestEngineCommandPort } from "./testEngineCommandPort.ts";
import type {
  AgentSessionEngineState,
  EngineClock,
  EngineExtensionCommand,
  EngineExternalCommand,
  EngineScheduler
} from "./types.ts";

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

function committedForkResult(
  childSession: typeof session,
  input: {
    requestId: string;
    sourceAgentSessionId?: string;
    turnId?: string;
  }
) {
  const operationId = `operation-${input.requestId}`;
  const sourceAgentSessionId = input.sourceAgentSessionId ?? "session-1";
  const turnId = input.turnId ?? "turn-1";
  return {
    error: null,
    operationId,
    requestId: input.requestId,
    session: {
      ...childSession,
      forkedFrom: {
        forkedAtUnixMs: 2,
        operationId,
        sourceAgentSessionId,
        sourceTurnId: turnId,
        targetTurnId: `target-${turnId}`
      }
    },
    sourceAgentSessionId,
    status: "committed" as const,
    targetAgentSessionId: childSession.agentSessionId,
    turnId
  };
}

function forkChild(
  targetAgentSessionId: string,
  operationId: string,
  sourceAgentSessionId: string,
  sourceTurnId: string
) {
  return normalizeAgentActivitySession({
    ...session,
    agentSessionId: targetAgentSessionId,
    forkedFrom: {
      forkedAtUnixMs: 2,
      operationId,
      sourceAgentSessionId,
      sourceTurnId,
      targetTurnId: `target-${sourceTurnId}`
    }
  });
}

function forkReducerContext() {
  const source = normalizeAgentActivitySession({
    ...session,
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  return {
    deletedSessionIds: {},
    sessionsById: { "session-1": source },
    turnsById: {
      [canonicalTurnKey("session-1", "turn-1")]: {
        agentSessionId: "session-1",
        completedCommand: null,
        error: null,
        fileChanges: null,
        origin: "user_prompt" as const,
        outcome: "completed" as const,
        phase: "settled" as const,
        providerForkBindingAvailable: true,
        providerForkBindingState: "bound" as const,
        settledAtUnixMs: 2,
        startedAtUnixMs: 1,
        turnId: "turn-1",
        updatedAtUnixMs: 2
      }
    }
  };
}

interface ManualTimer {
  advance(ms: number): void;
  clock: EngineClock;
  pendingTaskCount(): number;
  scheduler: EngineScheduler;
}

function createManualTimer(): ManualTimer {
  let nowUnixMs = 0;
  let sequence = 0;
  const tasks: {
    atUnixMs: number;
    cancelled: boolean;
    run: () => void;
    sequence: number;
  }[] = [];
  return {
    advance(ms) {
      nowUnixMs += ms;
      for (;;) {
        const due = tasks
          .filter((task) => !task.cancelled && task.atUnixMs <= nowUnixMs)
          .sort(
            (left, right) =>
              left.atUnixMs - right.atUnixMs || left.sequence - right.sequence
          )[0];
        if (!due) return;
        due.cancelled = true;
        due.run();
      }
    },
    clock: { nowUnixMs: () => nowUnixMs },
    pendingTaskCount: () => tasks.filter((task) => !task.cancelled).length,
    scheduler: {
      schedule(delayMs, run) {
        const task = {
          atUnixMs: nowUnixMs + delayMs,
          cancelled: false,
          run,
          sequence
        };
        sequence += 1;
        tasks.push(task);
        return {
          cancel() {
            task.cancelled = true;
          }
        };
      }
    }
  };
}

async function flushCommandResults(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("pin result commits mutation and canonical session in one engine notification", async () => {
  let resolveCommand: (value: unknown) => void = () => {};
  const commandPort = createTestEngineCommandPort(
    async () =>
      new Promise((resolve) => {
        resolveCommand = resolve;
      })
  );
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

  const resultPromise = dispatchSessionMutationWithCancellation(engine, {
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

test("rename result commits mutation and canonical session in one engine notification", async () => {
  let resolveCommand: (value: unknown) => void = () => {};
  const commandPort = createTestEngineCommandPort(
    async () =>
      new Promise((resolve) => {
        resolveCommand = resolve;
      })
  );
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

  const resultPromise = dispatchSessionMutationWithCancellation(engine, {
    agentSessionId: "session-1",
    mutationId: "rename-1",
    title: "  Renamed session  ",
    type: "session/renameRequested",
    workspaceId: "workspace-1"
  });
  assert.equal(states.length, 1);
  assert.deepEqual(states[0]?.sessionMutations.byMutationId["rename-1"], {
    agentSessionIds: ["session-1"],
    commandId: "rename-1",
    errorCode: null,
    errorMessage: null,
    kind: "rename",
    mutationId: "rename-1",
    status: "inFlight",
    title: "Renamed session",
    workspaceId: "workspace-1"
  });
  assert.equal(
    states[0]?.sessionLifecycle.sessionsById["session-1"]?.title,
    "Session"
  );

  resolveCommand({
    session: { ...session, title: "Renamed session", updatedAtUnixMs: 2 }
  });
  await resultPromise;

  assert.equal(states.length, 2);
  assert.equal(
    states[1]?.sessionMutations.byMutationId["rename-1"]?.status,
    "succeeded"
  );
  assert.equal(
    states[1]?.sessionLifecycle.sessionsById["session-1"]?.title,
    "Renamed session"
  );
  assert.equal(
    states.some(
      (state) =>
        state.sessionMutations.byMutationId["rename-1"]?.status ===
          "succeeded" &&
        state.sessionLifecycle.sessionsById["session-1"]?.title === "Session"
    ),
    false
  );
  engine.dispose();
});

test("engine rename method owns mutation protocol and returns the canonical session", async () => {
  let resolveCommand: (value: unknown) => void = () => {};
  let command: EngineExternalCommand | null = null;
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 42 },
    commandPort: createTestEngineCommandPort(async (nextCommand) => {
      command = nextCommand;
      return new Promise((resolve) => {
        resolveCommand = resolve;
      });
    }),
    identity: { origin: "local", workspaceId: "workspace-1" },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
  engine.dispatch({ session, type: "session/upserted" });

  const resultPromise = engine.renameSession({
    agentSessionId: " session-1 ",
    title: "  Renamed session  "
  });

  assert.deepEqual(command, {
    agentSessionId: "session-1",
    commandId: "rename:42:1",
    correlationId: "rename:42:1",
    timeoutMs: 30_000,
    title: "Renamed session",
    type: "session/rename",
    workspaceId: "workspace-1"
  });
  resolveCommand({
    session: { ...session, title: "Renamed session", updatedAtUnixMs: 2 }
  });

  const result = await resultPromise;
  assert.equal(result.title, "Renamed session");
  assert.equal(
    engine.getSnapshot().sessionLifecycle.sessionsById["session-1"]?.title,
    result.title
  );
  engine.dispose();
});

test("engine rename method aborts its host effect when the caller cancels", async () => {
  let effectSignal: AbortSignal | undefined;
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 42 },
    commandPort: createTestEngineCommandPort(async (_command, options) => {
      effectSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true }
        );
      });
    }),
    identity: { origin: "local", workspaceId: "workspace-1" },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
  engine.dispatch({ session, type: "session/upserted" });
  const controller = new AbortController();

  const resultPromise = engine.renameSession({
    agentSessionId: "session-1",
    signal: controller.signal,
    title: "Renamed session"
  });
  controller.abort();

  await assert.rejects(
    resultPromise,
    (error: Error & { code?: string }) =>
      error.name === "AbortError" && error.code === "aborted"
  );
  assert.equal(effectSignal?.aborted, true);
  await flushCommandResults();
  const mutation = Object.values(
    engine.getSnapshot().sessionMutations.byMutationId
  )[0];
  assert.equal(mutation?.status, "unknown");
  assert.equal(mutation?.errorCode, "aborted");
  engine.dispose();
});

test("rename rejects an authoritative session with a different title", () => {
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      agentSessionId: "session-1",
      mutationId: "rename-mismatch",
      title: "Renamed session",
      type: "session/renameRequested",
      workspaceId: "workspace-1"
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );
  const settled = sessionMutationsReducer(
    requested.state,
    {
      commandId: "rename-mismatch",
      commandType: "session/rename",
      correlationId: "rename-mismatch",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: { session }
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );

  assert.equal(
    settled.state.byMutationId["rename-mismatch"]?.status,
    "unknown"
  );
  assert.equal(
    settled.state.byMutationId["rename-mismatch"]?.errorCode,
    "invalid_command_result"
  );
  assert.equal(settled.followUpIntents, undefined);
});

test("rename rejects empty titles before reaching the command port", async () => {
  let commandCalls = 0;
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 0 },
    commandPort: createTestEngineCommandPort(async () => {
      commandCalls += 1;
    }),
    identity: { origin: "local", workspaceId: "workspace-1" },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
  engine.dispatch({ session, type: "session/upserted" });

  await assert.rejects(
    dispatchSessionMutationWithCancellation(engine, {
      agentSessionId: "session-1",
      mutationId: "rename-empty",
      title: "   ",
      type: "session/renameRequested",
      workspaceId: "workspace-1"
    }),
    /session mutation was not accepted/
  );
  assert.equal(commandCalls, 0);
  engine.dispose();
});

test("rename timeout remains delivery-unknown without changing canonical state", () => {
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      agentSessionId: "session-1",
      mutationId: "rename-timeout",
      title: "Renamed session",
      type: "session/renameRequested",
      workspaceId: "workspace-1"
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );
  const timedOut = sessionMutationsReducer(
    requested.state,
    {
      commandId: "rename-timeout",
      commandType: "session/rename",
      correlationId: "rename-timeout",
      outcome: "timedOut",
      type: "engine/commandResult"
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );

  assert.equal(
    timedOut.state.byMutationId["rename-timeout"]?.status,
    "unknown"
  );
  assert.equal(
    timedOut.state.byMutationId["rename-timeout"]?.errorCode,
    "timeout"
  );
  assert.equal(timedOut.followUpIntents, undefined);
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

test("delete result accepts an idempotent no-op", () => {
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      agentSessionIds: ["session-1"],
      mutationId: "delete-replay-1",
      type: "sessions/deleteRequested",
      workspaceId: "workspace-1"
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );
  const succeeded = sessionMutationsReducer(
    requested.state,
    {
      commandId: "delete-replay-1",
      commandType: "sessions/delete",
      correlationId: "delete-replay-1",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: {
        cleanupFailedSessionIds: [],
        removedMessages: 0,
        removedSessionIds: [],
        removedSessions: 0
      }
    },
    { deletedSessionIds: {}, sessionsById: { "session-1": session } }
  );

  assert.equal(
    succeeded.state.byMutationId["delete-replay-1"]?.status,
    "succeeded"
  );
  assert.deepEqual(succeeded.followUpIntents, [
    { agentSessionId: "session-1", type: "session/removed" }
  ]);
});

test("through-turn fork preserves exact identities and upserts the child session", () => {
  const forkableSession = normalizeAgentActivitySession({
    ...session,
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  const turn = {
    agentSessionId: "session-1",
    completedCommand: null,
    error: null,
    fileChanges: null,
    origin: "user_prompt" as const,
    outcome: "completed" as const,
    phase: "settled" as const,
    providerForkBindingAvailable: true,
    settledAtUnixMs: 2,
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 2
  };
  const context = {
    deletedSessionIds: {},
    sessionsById: { "session-1": forkableSession },
    turnsById: { [canonicalTurnKey("session-1", "turn-1")]: turn }
  };
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-1",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "session-2",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );

  assert.deepEqual(requested.commands, [
    {
      commandId: "request-1",
      correlationId: "request-1",
      requestId: "request-1",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "session-2",
      turnId: "turn-1",
      type: "session/forkThroughTurn",
      workspaceId: "workspace-1"
    }
  ]);
  const duplicateBoundary = sessionMutationsReducer(
    requested.state,
    {
      requestId: "request-2",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "session-3",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  assert.deepEqual(duplicateBoundary.commands, []);
  assert.equal(duplicateBoundary.state.byMutationId["request-2"], undefined);

  const child = normalizeAgentActivitySession({
    ...session,
    agentSessionId: "session-2",
    forkedFrom: {
      forkedAtUnixMs: 2,
      operationId: "operation-request-1",
      sourceAgentSessionId: "session-1",
      sourceTurnId: "turn-1",
      targetTurnId: "target-turn-1"
    },
    title: "Forked session"
  });
  const accepted = sessionMutationsReducer(
    requested.state,
    {
      commandId: "request-1",
      commandType: "session/forkThroughTurn",
      correlationId: "request-1",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: {
        error: null,
        operationId: "operation-request-1",
        requestId: "request-1",
        session: null,
        sourceAgentSessionId: "session-1",
        status: "accepted",
        targetAgentSessionId: "session-2",
        turnId: "turn-1"
      }
    },
    context
  );
  assert.equal(accepted.state.byMutationId["request-1"]?.status, "inFlight");
  assert.equal(
    accepted.state.byMutationId["request-1"]?.kind === "forkThroughTurn"
      ? accepted.state.byMutationId["request-1"].operationId
      : null,
    "operation-request-1"
  );
  assert.deepEqual(accepted.followUpIntents, undefined);
  const acceptedCommittedByProjection = sessionMutationsReducer(
    accepted.state,
    { session: child, type: "session/upserted" },
    context
  );
  assert.equal(
    acceptedCommittedByProjection.state.byMutationId["request-1"]?.status,
    "succeeded"
  );
  assert.deepEqual(acceptedCommittedByProjection.commands, [
    {
      commandId: "session-fork-observed:operation-request-1",
      correlationId: "request-1",
      operationId: "operation-request-1",
      timeoutMs: SESSION_FORK_OBSERVATION_ACK_TIMEOUT_MS,
      type: "session/ackForkObserved",
      workspaceId: "workspace-1"
    }
  ]);

  const succeeded = sessionMutationsReducer(
    requested.state,
    {
      commandId: "request-1",
      commandType: "session/forkThroughTurn",
      correlationId: "request-1",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: committedForkResult(child, { requestId: "request-1" })
    },
    context
  );

  assert.equal(succeeded.state.byMutationId["request-1"]?.status, "inFlight");
  assert.deepEqual(succeeded.followUpIntents, [
    {
      session: committedForkResult(child, { requestId: "request-1" }).session,
      type: "session/upserted"
    }
  ]);
  const observed = sessionMutationsReducer(
    succeeded.state,
    succeeded.followUpIntents?.[0] ?? {
      session: child,
      type: "session/upserted"
    },
    context
  );
  assert.equal(observed.state.byMutationId["request-1"]?.status, "succeeded");
  assert.equal(
    observed.state.byMutationId["request-1"]?.kind === "forkThroughTurn"
      ? observed.state.byMutationId["request-1"].ackStatus
      : null,
    "inFlight"
  );
});

test("fork observation rejects lineage without a target Turn identity", () => {
  const context = forkReducerContext();
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-missing-target-turn",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "session-child",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  const child = forkChild(
    "session-child",
    "operation-request-missing-target-turn",
    "session-1",
    "turn-1"
  );
  child.forkedFrom!.targetTurnId = "";
  const observed = sessionMutationsReducer(
    requested.state,
    { session: child, type: "session/upserted" },
    context
  );

  assert.equal(
    observed.state.byMutationId["request-missing-target-turn"]?.status,
    "inFlight"
  );
  assert.deepEqual(observed.commands, []);
});

test("recovered committed fork adopts its durable identity before ACK", () => {
  const context = forkReducerContext();
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-after-restart",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "target-after-restart",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  const recoveredChild = forkChild(
    "durable-target",
    "durable-operation",
    "session-1",
    "turn-1"
  );
  const recovered = sessionMutationsReducer(
    requested.state,
    {
      commandId: "request-after-restart",
      commandType: "session/forkThroughTurn",
      correlationId: "request-after-restart",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: {
        error: null,
        operationId: "durable-operation",
        requestId: "durable-request",
        session: recoveredChild,
        sourceAgentSessionId: "session-1",
        status: "committed",
        targetAgentSessionId: "durable-target",
        turnId: "turn-1"
      }
    },
    context
  );
  const recoveredRecord = recovered.state.byMutationId["request-after-restart"];
  assert.equal(recoveredRecord?.kind, "forkThroughTurn");
  if (recoveredRecord?.kind !== "forkThroughTurn") {
    throw new Error("missing recovered fork record");
  }
  assert.equal(recoveredRecord.requestId, "durable-request");
  assert.equal(recoveredRecord.targetAgentSessionId, "durable-target");
  assert.equal(recoveredRecord.operationId, "durable-operation");
  assert.equal(recoveredRecord.status, "inFlight");
  assert.deepEqual(recovered.followUpIntents, [
    { session: recoveredChild, type: "session/upserted" }
  ]);

  const observed = sessionMutationsReducer(
    recovered.state,
    { session: recoveredChild, type: "session/upserted" },
    context
  );
  assert.equal(
    observed.state.byMutationId["request-after-restart"]?.status,
    "succeeded"
  );
  assert.deepEqual(observed.commands, [
    {
      commandId: "session-fork-observed:durable-operation",
      correlationId: "request-after-restart",
      operationId: "durable-operation",
      timeoutMs: SESSION_FORK_OBSERVATION_ACK_TIMEOUT_MS,
      type: "session/ackForkObserved",
      workspaceId: "workspace-1"
    }
  ]);
});

test("fork observation ACK failure retries after bounded backoff without a new event", () => {
  const context = forkReducerContext();
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-ack",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "target-ack",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  const child = forkChild("target-ack", "operation-ack", "session-1", "turn-1");
  const observed = sessionMutationsReducer(
    requested.state,
    { session: child, type: "session/upserted" },
    context
  );
  const failedAck = sessionMutationsReducer(
    observed.state,
    {
      commandId: "session-fork-observed:operation-ack",
      commandType: "session/ackForkObserved",
      correlationId: "request-ack",
      errorMessage: "daemon unavailable",
      outcome: "failed",
      type: "engine/commandResult"
    },
    context
  );
  const pending = failedAck.state.byMutationId["request-ack"];
  assert.equal(pending?.status, "succeeded");
  assert.equal(
    pending?.kind === "forkThroughTurn" ? pending.ackStatus : null,
    "pending"
  );
  assert.deepEqual(failedAck.commands, [
    {
      delayMs: SESSION_FORK_OBSERVATION_ACK_RETRY_BACKOFF_MS[0],
      expiryId: "session-fork-observed-retry:operation-ack",
      type: "engine/scheduleExpiryAfter"
    }
  ]);

  const retried = sessionMutationsReducer(
    failedAck.state,
    {
      dueAtUnixMs: SESSION_FORK_OBSERVATION_ACK_RETRY_BACKOFF_MS[0],
      expiryId: "session-fork-observed-retry:operation-ack",
      type: "engine/intentExpired"
    },
    context
  );
  assert.deepEqual(retried.commands, observed.commands);
  assert.equal(
    retried.commands.some(
      (command) => command.type === "session/forkThroughTurn"
    ),
    false
  );
  const acknowledged = sessionMutationsReducer(
    retried.state,
    {
      commandId: "session-fork-observed:operation-ack",
      commandType: "session/ackForkObserved",
      correlationId: "request-ack",
      outcome: "succeeded",
      type: "engine/commandResult"
    },
    context
  );
  assert.equal(
    acknowledged.state.byMutationId["request-ack"]?.kind === "forkThroughTurn"
      ? acknowledged.state.byMutationId["request-ack"].ackStatus
      : null,
    "acknowledged"
  );
});

test("unresolved fork observation ACK does not block a new Fork", () => {
  const context = forkReducerContext();
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-coordination",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "target-coordination",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  const child = forkChild(
    "target-coordination",
    "operation-coordination",
    "session-1",
    "turn-1"
  );
  const observed = sessionMutationsReducer(
    requested.state,
    { session: child, type: "session/upserted" },
    context
  );
  const failedAck = sessionMutationsReducer(
    observed.state,
    {
      commandId: "session-fork-observed:operation-coordination",
      commandType: "session/ackForkObserved",
      correlationId: "request-coordination",
      outcome: "failed",
      type: "engine/commandResult"
    },
    context
  );
  const newRequest = sessionMutationsReducer(
    failedAck.state,
    {
      requestId: "request-new-fork",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "target-new-fork",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );

  assert.equal(newRequest.commands[0]?.type, "session/forkThroughTurn");
  assert.equal(
    newRequest.state.byMutationId["request-coordination"]?.kind,
    "forkThroughTurn"
  );
  assert.equal(
    newRequest.state.byMutationId["request-new-fork"]?.status,
    "inFlight"
  );
  const pinRequest = sessionMutationsReducer(
    failedAck.state,
    {
      agentSessionId: "session-1",
      mutationId: "pin-during-ack",
      pinned: true,
      type: "session/pinRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  assert.equal(pinRequest.commands[0]?.type, "session/setPinned");
  assert.equal(
    pinRequest.state.byMutationId["request-coordination"]?.kind,
    "forkThroughTurn"
  );
  const turn2Context = {
    ...context,
    turnsById: {
      ...context.turnsById,
      [canonicalTurnKey("session-1", "turn-2")]: {
        agentSessionId: "session-1",
        completedCommand: null,
        error: null,
        fileChanges: null,
        origin: "user_prompt" as const,
        outcome: "completed" as const,
        phase: "settled" as const,
        providerForkBindingAvailable: true,
        settledAtUnixMs: 3,
        startedAtUnixMs: 2,
        turnId: "turn-2",
        updatedAtUnixMs: 3
      }
    }
  };
  const differentBoundary = sessionMutationsReducer(
    failedAck.state,
    {
      requestId: "request-different-boundary",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "target-different-boundary",
      turnId: "turn-2",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    turn2Context
  );
  assert.equal(differentBoundary.commands[0]?.type, "session/forkThroughTurn");
});

test("session removal does not revoke an observed child or cancel its pending ACK", () => {
  const context = forkReducerContext();
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-remove",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "target-remove",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  const child = forkChild(
    "target-remove",
    "operation-remove",
    "session-1",
    "turn-1"
  );
  const observed = sessionMutationsReducer(
    requested.state,
    { session: child, type: "session/upserted" },
    context
  );
  const failed = sessionMutationsReducer(
    observed.state,
    {
      commandId: "session-fork-observed:operation-remove",
      commandType: "session/ackForkObserved",
      correlationId: "request-remove",
      outcome: "failed",
      type: "engine/commandResult"
    },
    context
  );
  const removed = sessionMutationsReducer(
    failed.state,
    { agentSessionId: "target-remove", type: "session/removed" },
    context
  );

  assert.deepEqual(removed.commands, []);
  assert.equal(
    removed.state.byMutationId["request-remove"]?.kind === "forkThroughTurn"
      ? removed.state.byMutationId["request-remove"].ackStatus
      : null,
    "pending"
  );
  assert.equal(
    sessionMutationsReducer(
      removed.state,
      {
        dueAtUnixMs: 1_000,
        expiryId: "session-fork-observed-retry:operation-remove",
        type: "engine/intentExpired"
      },
      context
    ).commands[0]?.type,
    "session/ackForkObserved"
  );
});

test("session removal retains provider in-flight and delivery-unknown fork coordination", () => {
  const context = forkReducerContext();
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-provider-coordination",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "target-provider-coordination",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  const removedWhileInFlight = sessionMutationsReducer(
    requested.state,
    { agentSessionId: "session-1", type: "session/removed" },
    context
  );

  assert.equal(
    removedWhileInFlight.state.byMutationId["request-provider-coordination"]
      ?.status,
    "inFlight"
  );

  const unknown = sessionMutationsReducer(
    requested.state,
    {
      commandId: "request-provider-coordination",
      commandType: "session/forkThroughTurn",
      correlationId: "request-provider-coordination",
      errorReason: "agent_session_fork_delivery_unknown",
      outcome: "failed",
      type: "engine/commandResult"
    },
    context
  );
  const removedWhileUnknown = sessionMutationsReducer(
    unknown.state,
    { agentSessionId: "target-provider-coordination", type: "session/removed" },
    context
  );

  assert.equal(
    removedWhileUnknown.state.byMutationId["request-provider-coordination"]
      ?.status,
    "unknown"
  );
});

test("hung fork ACK times out, retries with the same identity, and stops after success", async () => {
  const timer = createManualTimer();
  const executedCommands: EngineExternalCommand[] = [];
  const engine = createAgentSessionEngine({
    clock: timer.clock,
    commandPort: createTestEngineCommandPort(async (command) => {
      executedCommands.push(command);
      if (command.type === "session/forkThroughTurn") {
        const child = forkChild(
          command.targetAgentSessionId,
          `operation-${command.requestId}`,
          command.sourceAgentSessionId,
          command.turnId
        );
        return committedForkResult(child, {
          requestId: command.requestId,
          sourceAgentSessionId: command.sourceAgentSessionId,
          turnId: command.turnId
        });
      }
      if (command.type === "session/ackForkObserved") {
        const attempts = executedCommands.filter(
          (candidate) => candidate.type === "session/ackForkObserved"
        ).length;
        if (attempts === 1) {
          return new Promise(() => {});
        }
        return {};
      }
      throw new Error(`unexpected command ${command.type}`);
    }),
    identity: { origin: "local", workspaceId: "workspace-1" },
    scheduler: timer.scheduler
  });
  const context = forkReducerContext();
  engine.dispatch({
    session: context.sessionsById["session-1"]!,
    type: "session/upserted"
  });
  engine.dispatch({
    turn: context.turnsById[canonicalTurnKey("session-1", "turn-1")]!,
    live: true,
    type: "turn/upserted"
  });
  engine.dispatch({
    requestId: "request-hung-ack",
    sourceAgentSessionId: "session-1",
    targetAgentSessionId: "target-hung-ack",
    turnId: "turn-1",
    type: "session/forkThroughTurnRequested",
    workspaceId: "workspace-1"
  });
  await flushCommandResults();

  const firstAck = executedCommands.filter(
    (command) => command.type === "session/ackForkObserved"
  )[0];
  assert.ok(firstAck);
  assert.equal(firstAck.timeoutMs, SESSION_FORK_OBSERVATION_ACK_TIMEOUT_MS);

  timer.advance(SESSION_FORK_OBSERVATION_ACK_TIMEOUT_MS);
  const timedOutRecord =
    engine.getSnapshot().sessionMutations.byMutationId["request-hung-ack"];
  assert.equal(
    timedOutRecord?.kind === "forkThroughTurn"
      ? timedOutRecord.ackStatus
      : null,
    "pending"
  );
  timer.advance(SESSION_FORK_OBSERVATION_ACK_RETRY_BACKOFF_MS[0] - 1);
  assert.equal(
    executedCommands.filter(
      (command) => command.type === "session/ackForkObserved"
    ).length,
    1
  );
  timer.advance(1);
  await flushCommandResults();

  const ackCommands = executedCommands.filter(
    (
      command
    ): command is Extract<
      EngineExternalCommand,
      { type: "session/ackForkObserved" }
    > => command.type === "session/ackForkObserved"
  );
  assert.equal(ackCommands.length, 2);
  assert.equal(ackCommands[1]?.commandId, ackCommands[0]?.commandId);
  assert.equal(ackCommands[1]?.operationId, ackCommands[0]?.operationId);
  const acknowledgedRecord =
    engine.getSnapshot().sessionMutations.byMutationId["request-hung-ack"];
  assert.equal(
    acknowledgedRecord?.kind === "forkThroughTurn"
      ? acknowledgedRecord.ackStatus
      : null,
    "acknowledged"
  );

  timer.advance(120_000);
  await flushCommandResults();
  assert.equal(
    executedCommands.filter(
      (command) => command.type === "session/ackForkObserved"
    ).length,
    2
  );
  assert.equal(timer.pendingTaskCount(), 0);
  engine.dispose();
});

test("realtime fork child before POST result ACKs exactly once", () => {
  const context = forkReducerContext();
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-race",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "target-race",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  const child = forkChild(
    "target-race",
    "operation-request-race",
    "session-1",
    "turn-1"
  );
  const eventFirst = sessionMutationsReducer(
    requested.state,
    { session: child, type: "session/upserted" },
    context
  );
  assert.equal(eventFirst.commands.length, 1);
  assert.equal(eventFirst.commands[0]?.type, "session/ackForkObserved");

  const duplicateEvent = sessionMutationsReducer(
    eventFirst.state,
    { session: child, type: "session/upserted" },
    context
  );
  assert.deepEqual(duplicateEvent.commands, []);

  const latePost = sessionMutationsReducer(
    duplicateEvent.state,
    {
      commandId: "request-race",
      commandType: "session/forkThroughTurn",
      correlationId: "request-race",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: committedForkResult(child, { requestId: "request-race" })
    },
    context
  );
  assert.deepEqual(latePost.commands, []);
  assert.equal(
    latePost.state.byMutationId["request-race"]?.status,
    "succeeded"
  );
});

test("through-turn fork is rejected when exact-session capability is absent", () => {
  const result = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-1",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "session-2",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    {
      deletedSessionIds: {},
      sessionsById: { "session-1": session },
      turnsById: {
        [canonicalTurnKey("session-1", "turn-1")]: {
          agentSessionId: "session-1",
          completedCommand: null,
          error: null,
          fileChanges: null,
          origin: "user_prompt",
          outcome: "completed",
          phase: "settled",
          providerForkBindingAvailable: true,
          settledAtUnixMs: 2,
          startedAtUnixMs: 1,
          turnId: "turn-1",
          updatedAtUnixMs: 2
        }
      }
    }
  );

  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.state.byMutationId, {});
});

test("through-turn fork rejects a settled boundary that still requires provider binding recovery", () => {
  const base = forkReducerContext();
  const context = {
    ...base,
    turnsById: {
      ...base.turnsById,
      [canonicalTurnKey("session-1", "turn-1")]: {
        ...base.turnsById[canonicalTurnKey("session-1", "turn-1")]!,
        providerForkBindingAvailable: false,
        providerForkBindingState: "recovery_required" as const
      }
    }
  };

  const result = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-recovery",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "session-2",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    context
  );

  assert.deepEqual(result.commands, []);
  assert.equal(result.state.byMutationId["request-recovery"], undefined);
});

test("through-turn fork remains available while the source has an active turn", () => {
  const forkableButBusy = normalizeAgentActivitySession({
    ...session,
    activeTurnId: "turn-active",
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  const result = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-busy",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "session-2",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    {
      deletedSessionIds: {},
      sessionsById: { "session-1": forkableButBusy },
      turnsById: {
        [canonicalTurnKey("session-1", "turn-1")]: {
          agentSessionId: "session-1",
          completedCommand: null,
          error: null,
          fileChanges: null,
          origin: "user_prompt",
          outcome: "completed",
          phase: "settled",
          providerForkBindingAvailable: true,
          settledAtUnixMs: 2,
          startedAtUnixMs: 1,
          turnId: "turn-1",
          updatedAtUnixMs: 2
        }
      }
    }
  );
  assert.equal(result.commands[0]?.type, "session/forkThroughTurn");
  assert.equal(result.state.byMutationId["request-busy"]?.status, "inFlight");
});

test("through-turn fork remains available while the source has a pending interaction", () => {
  const forkableSession = normalizeAgentActivitySession({
    ...session,
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  const result = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    {
      requestId: "request-pending",
      sourceAgentSessionId: "session-1",
      targetAgentSessionId: "session-2",
      turnId: "turn-1",
      type: "session/forkThroughTurnRequested",
      workspaceId: "workspace-1"
    },
    {
      deletedSessionIds: {},
      interactionsById: {
        "request-approval": {
          agentSessionId: "session-1",
          createdAtUnixMs: 2,
          kind: "approval",
          requestId: "request-approval",
          status: "pending",
          turnId: "turn-1",
          updatedAtUnixMs: 2
        }
      },
      sessionsById: { "session-1": forkableSession },
      turnsById: {
        [canonicalTurnKey("session-1", "turn-1")]: {
          agentSessionId: "session-1",
          completedCommand: null,
          error: null,
          fileChanges: null,
          origin: "user_prompt",
          outcome: "completed",
          phase: "settled",
          providerForkBindingAvailable: true,
          settledAtUnixMs: 2,
          startedAtUnixMs: 1,
          turnId: "turn-1",
          updatedAtUnixMs: 2
        }
      }
    }
  );
  assert.equal(result.commands[0]?.type, "session/forkThroughTurn");
  assert.equal(
    result.state.byMutationId["request-pending"]?.status,
    "inFlight"
  );
});

test("through-turn fork replays the same request after timeout and confirms a late child", () => {
  const source = normalizeAgentActivitySession({
    ...session,
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  const turn = {
    agentSessionId: "session-1",
    completedCommand: null,
    error: null,
    fileChanges: null,
    origin: "user_prompt" as const,
    outcome: "completed" as const,
    phase: "settled" as const,
    providerForkBindingAvailable: true,
    settledAtUnixMs: 2,
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 2
  };
  const context = {
    deletedSessionIds: {},
    sessionsById: { "session-1": source },
    turnsById: { [canonicalTurnKey("session-1", "turn-1")]: turn }
  };
  const intent = {
    requestId: "request-stable",
    sourceAgentSessionId: "session-1",
    targetAgentSessionId: "session-child",
    turnId: "turn-1",
    type: "session/forkThroughTurnRequested" as const,
    workspaceId: "workspace-1"
  };
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    intent,
    context
  );
  const timedOut = sessionMutationsReducer(
    requested.state,
    {
      commandId: "request-stable",
      commandType: "session/forkThroughTurn",
      correlationId: "request-stable",
      outcome: "timedOut",
      type: "engine/commandResult"
    },
    context
  );
  assert.equal(
    timedOut.state.byMutationId["request-stable"]?.status,
    "unknown"
  );

  const replayed = sessionMutationsReducer(timedOut.state, intent, context);
  assert.equal(
    replayed.state.byMutationId["request-stable"]?.status,
    "inFlight"
  );
  assert.deepEqual(replayed.commands, requested.commands);

  const child = normalizeAgentActivitySession({
    ...session,
    agentSessionId: "session-child",
    forkedFrom: {
      forkedAtUnixMs: 2,
      operationId: "operation-request-stable",
      sourceAgentSessionId: "session-1",
      sourceTurnId: "turn-1",
      targetTurnId: "target-turn-1"
    }
  });
  const confirmed = sessionMutationsReducer(
    timedOut.state,
    { session: child, type: "session/upserted" },
    context
  );
  assert.equal(
    confirmed.state.byMutationId["request-stable"]?.status,
    "succeeded"
  );
});

test("through-turn fork keeps stable identity for a typed delivery-unknown failure", () => {
  const source = normalizeAgentActivitySession({
    ...session,
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  const turn = {
    agentSessionId: "session-1",
    completedCommand: null,
    error: null,
    fileChanges: null,
    origin: "user_prompt" as const,
    outcome: "completed" as const,
    phase: "settled" as const,
    providerForkBindingAvailable: true,
    settledAtUnixMs: 2,
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 2
  };
  const context = {
    deletedSessionIds: {},
    sessionsById: { "session-1": source },
    turnsById: { [canonicalTurnKey("session-1", "turn-1")]: turn }
  };
  const intent = {
    requestId: "request-unknown",
    sourceAgentSessionId: "session-1",
    targetAgentSessionId: "session-child",
    turnId: "turn-1",
    type: "session/forkThroughTurnRequested" as const,
    workspaceId: "workspace-1"
  };
  const requested = sessionMutationsReducer(
    createInitialSessionMutationsState(),
    intent,
    context
  );
  const unknown = sessionMutationsReducer(
    requested.state,
    {
      commandId: "request-unknown",
      commandType: "session/forkThroughTurn",
      correlationId: "request-unknown",
      errorReason: "agent_session_fork_delivery_unknown",
      outcome: "failed",
      type: "engine/commandResult"
    },
    context
  );
  assert.equal(
    unknown.state.byMutationId["request-unknown"]?.status,
    "unknown"
  );
  assert.deepEqual(
    sessionMutationsReducer(unknown.state, intent, context).commands,
    requested.commands
  );

  let pruned = unknown.state;
  for (let index = 0; index < 160; index += 1) {
    const mutationId = `delete-after-unknown-${index}`;
    const agentSessionId = `other-session-${index}`;
    pruned = sessionMutationsReducer(
      pruned,
      {
        agentSessionIds: [agentSessionId],
        mutationId,
        type: "sessions/deleteRequested",
        workspaceId: "workspace-1"
      },
      { deletedSessionIds: {}, sessionsById: {} }
    ).state;
    pruned = sessionMutationsReducer(
      pruned,
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
  assert.equal(
    pruned.byMutationId["request-unknown"]?.status,
    "unknown",
    "unresolved provider identity must outlive ordinary settled history"
  );
  assert.deepEqual(
    sessionMutationsReducer(pruned, intent, context).commands,
    requested.commands
  );
});

test("through-turn fork facade allocates a new identity after a confirmed failure", async () => {
  const forkableSession = normalizeAgentActivitySession({
    ...session,
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  const childSession = normalizeAgentActivitySession({
    ...session,
    agentSessionId: "placeholder-child",
    title: "Forked session"
  });
  const commands: Array<
    Extract<EngineExtensionCommand, { type: "session/forkThroughTurn" }>
  > = [];
  let resolveReplay: (value: unknown) => void = () => {};
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 0 },
    commandPort: createTestEngineCommandPort(async (command) => {
      if (command.type === "session/ackForkObserved") {
        return {};
      }
      if (command.type !== "session/forkThroughTurn") {
        throw new Error(`unexpected command ${command.type}`);
      }
      commands.push(command);
      if (commands.length === 1) {
        throw new Error("definitive first failure");
      }
      return new Promise((resolve) => {
        resolveReplay = resolve;
      });
    }),
    identity: { origin: "local", workspaceId: "workspace-1" },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
  engine.dispatch({ session: forkableSession, type: "session/upserted" });
  engine.dispatch({
    turn: {
      agentSessionId: "session-1",
      completedCommand: null,
      error: null,
      fileChanges: null,
      origin: "user_prompt",
      outcome: "completed",
      phase: "settled",
      providerForkBindingAvailable: true,
      settledAtUnixMs: 2,
      startedAtUnixMs: 1,
      turnId: "turn-1",
      updatedAtUnixMs: 2
    },
    live: true,
    type: "turn/upserted"
  });

  const boundary = {
    sourceAgentSessionId: "session-1",
    turnId: "turn-1",
    workspaceId: "workspace-1"
  };
  await assert.rejects(
    dispatchSessionForkThroughTurn(engine, boundary),
    /definitive first failure/
  );
  const failed = selectSessionForkThroughTurnMutation(
    engine.getSnapshot(),
    boundary
  );
  assert.equal(failed?.status, "failed");

  const replay = dispatchSessionForkThroughTurn(engine, boundary);
  assert.deepEqual(
    selectPendingSessionForkThroughTurnIds(engine.getSnapshot(), {
      sourceAgentSessionId: "session-1",
      workspaceId: "workspace-1"
    }),
    ["turn-1"]
  );
  assert.equal(commands.length, 2);
  assert.notEqual(commands[1]?.requestId, commands[0]?.requestId);
  assert.notEqual(
    commands[1]?.targetAgentSessionId,
    commands[0]?.targetAgentSessionId
  );
  const replayCommand = commands[1];
  assert.ok(replayCommand);

  resolveReplay(
    committedForkResult(
      {
        ...childSession,
        agentSessionId: replayCommand.targetAgentSessionId
      },
      { requestId: replayCommand.requestId }
    )
  );
  const succeeded = await replay;
  assert.equal(succeeded.status, "succeeded");
  assert.equal(
    succeeded.targetAgentSessionId,
    commands[1]?.targetAgentSessionId
  );
  assert.equal(
    selectSessionForkThroughTurnMutation(engine.getSnapshot(), boundary),
    null
  );
  engine.dispose();
});

test("through-turn fork facade reuses an Engine-owned delivery-unknown identity", async () => {
  const forkableSession = normalizeAgentActivitySession({
    ...session,
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  const commands: Array<
    Extract<EngineExtensionCommand, { type: "session/forkThroughTurn" }>
  > = [];
  let resolveReplay: (value: unknown) => void = () => {};
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 0 },
    commandPort: createTestEngineCommandPort(async (command) => {
      if (command.type === "session/ackForkObserved") {
        return {};
      }
      if (command.type !== "session/forkThroughTurn") {
        throw new Error(`unexpected command ${command.type}`);
      }
      commands.push(command);
      if (commands.length === 1) {
        throw Object.assign(new Error("delivery outcome unknown"), {
          reason: "agent_session_fork_delivery_unknown"
        });
      }
      return new Promise((resolve) => {
        resolveReplay = resolve;
      });
    }),
    identity: { origin: "local", workspaceId: "workspace-1" },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
  engine.dispatch({ session: forkableSession, type: "session/upserted" });
  engine.dispatch({
    turn: {
      agentSessionId: "session-1",
      completedCommand: null,
      error: null,
      fileChanges: null,
      origin: "user_prompt",
      outcome: "completed",
      phase: "settled",
      providerForkBindingAvailable: true,
      settledAtUnixMs: 2,
      startedAtUnixMs: 1,
      turnId: "turn-1",
      updatedAtUnixMs: 2
    },
    live: true,
    type: "turn/upserted"
  });

  const boundary = {
    sourceAgentSessionId: "session-1",
    turnId: "turn-1",
    workspaceId: "workspace-1"
  };
  await assert.rejects(
    dispatchSessionForkThroughTurn(engine, boundary),
    /delivery outcome unknown/
  );
  const unknown = selectSessionForkThroughTurnMutation(
    engine.getSnapshot(),
    boundary
  );
  assert.equal(unknown?.status, "unknown");

  const replay = dispatchSessionForkThroughTurn(engine, boundary);
  assert.equal(commands.length, 2);
  const replayCommand = commands[1];
  assert.ok(replayCommand);
  assert.equal(replayCommand.requestId, commands[0]?.requestId);
  assert.equal(
    replayCommand.targetAgentSessionId,
    commands[0]?.targetAgentSessionId
  );

  resolveReplay(
    committedForkResult(
      normalizeAgentActivitySession({
        ...session,
        agentSessionId: replayCommand.targetAgentSessionId
      }),
      { requestId: replayCommand.requestId }
    )
  );
  const succeeded = await replay;
  assert.equal(succeeded.status, "succeeded");
  engine.dispose();
});

test("through-turn fork facade reuses an Engine-owned in-flight identity", async () => {
  const forkableSession = normalizeAgentActivitySession({
    ...session,
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  const commands: Array<
    Extract<EngineExtensionCommand, { type: "session/forkThroughTurn" }>
  > = [];
  let resolveCommands: (value: unknown) => void = () => {};
  const sharedExecution = new Promise((resolve) => {
    resolveCommands = resolve;
  });
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 0 },
    commandPort: createTestEngineCommandPort(async (command) => {
      if (command.type === "session/ackForkObserved") {
        return {};
      }
      if (command.type !== "session/forkThroughTurn") {
        throw new Error(`unexpected command ${command.type}`);
      }
      commands.push(command);
      return sharedExecution;
    }),
    identity: { origin: "local", workspaceId: "workspace-1" },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
  engine.dispatch({ session: forkableSession, type: "session/upserted" });
  engine.dispatch({
    turn: {
      agentSessionId: "session-1",
      completedCommand: null,
      error: null,
      fileChanges: null,
      origin: "user_prompt",
      outcome: "completed",
      phase: "settled",
      providerForkBindingAvailable: true,
      settledAtUnixMs: 2,
      startedAtUnixMs: 1,
      turnId: "turn-1",
      updatedAtUnixMs: 2
    },
    live: true,
    type: "turn/upserted"
  });

  const boundary = {
    sourceAgentSessionId: "session-1",
    turnId: "turn-1",
    workspaceId: "workspace-1"
  };
  const first = dispatchSessionForkThroughTurn(engine, boundary);
  const replay = dispatchSessionForkThroughTurn(engine, boundary);

  assert.equal(commands.length, 1);
  const command = commands[0];
  assert.ok(command);
  const inFlight = selectSessionForkThroughTurnMutation(
    engine.getSnapshot(),
    boundary
  );
  assert.equal(inFlight?.requestId, command.requestId);
  assert.equal(inFlight?.targetAgentSessionId, command.targetAgentSessionId);

  resolveCommands(
    committedForkResult(
      normalizeAgentActivitySession({
        ...session,
        agentSessionId: command.targetAgentSessionId
      }),
      { requestId: command.requestId }
    )
  );
  const [firstResult, replayResult] = await Promise.all([first, replay]);
  assert.equal(firstResult.requestId, replayResult.requestId);
  assert.equal(
    firstResult.targetAgentSessionId,
    replayResult.targetAgentSessionId
  );
  engine.dispose();
});

test("through-turn fork facade reuses the mutation key after committed recovery while ACK is pending", async () => {
  const forkableSession = normalizeAgentActivitySession({
    ...session,
    lifecycleCapabilities: { fork: true, forkThroughTurn: true }
  });
  let providerForkCalls = 0;
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 0 },
    commandPort: createTestEngineCommandPort(async (command) => {
      if (command.type === "session/ackForkObserved") {
        return new Promise(() => {});
      }
      if (command.type !== "session/forkThroughTurn") {
        throw new Error(`unexpected command ${command.type}`);
      }
      providerForkCalls += 1;
      return committedForkResult(
        normalizeAgentActivitySession({
          ...session,
          agentSessionId: "durable-target"
        }),
        { requestId: "durable-request" }
      );
    }),
    identity: { origin: "local", workspaceId: "workspace-1" },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
  engine.dispatch({ session: forkableSession, type: "session/upserted" });
  engine.dispatch({
    turn: {
      agentSessionId: "session-1",
      completedCommand: null,
      error: null,
      fileChanges: null,
      origin: "user_prompt",
      outcome: "completed",
      phase: "settled",
      providerForkBindingAvailable: true,
      settledAtUnixMs: 2,
      startedAtUnixMs: 1,
      turnId: "turn-1",
      updatedAtUnixMs: 2
    },
    live: true,
    type: "turn/upserted"
  });
  const boundary = {
    sourceAgentSessionId: "session-1",
    turnId: "turn-1",
    workspaceId: "workspace-1"
  };

  const recovered = await dispatchSessionForkThroughTurn(engine, boundary);
  assert.equal(recovered.requestId, "durable-request");
  assert.notEqual(recovered.mutationId, recovered.requestId);
  assert.equal(recovered.ackStatus, "inFlight");

  const replay = await dispatchSessionForkThroughTurn(engine, boundary);
  assert.equal(replay.mutationId, recovered.mutationId);
  assert.equal(replay.requestId, "durable-request");
  assert.equal(replay.targetAgentSessionId, "durable-target");
  assert.equal(providerForkCalls, 1);
  engine.dispose();
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
