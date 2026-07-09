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
    processedIntentCount: 0
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

test("root reducer composes domain slices without adding logic", () => {
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
