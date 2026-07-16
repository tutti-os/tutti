import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityComposerOptions } from "../types.ts";
import {
  composerOptionsReducer,
  createInitialComposerOptionsState
} from "./composerOptions.reducer.ts";
import type { ComposerOptionsLoadCommand } from "./composerOptions.types.ts";

function options(
  overrides: Partial<AgentActivityComposerOptions> = {}
): AgentActivityComposerOptions {
  return {
    provider: "codex",
    capabilities: null,
    models: [],
    reasoningEfforts: [],
    speeds: [],
    skills: [],
    behavior: {} as AgentActivityComposerOptions["behavior"],
    loadedAtUnixMs: 1,
    ...overrides
  };
}

function loadRequest(force = false) {
  return {
    type: "composerOptions/loadRequested" as const,
    commandId: "cmd-1",
    targetKey: "target-1",
    provider: "codex",
    workspaceId: "workspace-1",
    force
  };
}

test("loadRequested emits a load command and marks the target loading", () => {
  const result = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  );
  assert.equal(result.commands.length, 1);
  const command = result.commands[0] as ComposerOptionsLoadCommand;
  assert.equal(command.type, "composerOptions/load");
  assert.equal(command.correlationId, "target-1");
  assert.equal(result.state.entriesByTargetKey["target-1"]?.status, "loading");
});

test("a settled result stores options and marks the target ready", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options()
  }).state;
  assert.equal(state.entriesByTargetKey["target-1"]?.status, "ready");
  assert.equal(state.optionsByTargetKey["target-1"]?.provider, "codex");
});

test("a 4xx failure reaches a terminal error state without scheduling a retry", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  const result = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "failed",
    errorStatusCode: 400,
    errorMessage: "invalid request"
  });
  state = result.state;
  assert.equal(result.commands.length, 0);
  assert.equal(state.entriesByTargetKey["target-1"]?.status, "error");
  assert.equal(state.entriesByTargetKey["target-1"]?.inFlightCommandId, null);
});

function failLoad(commandId: string) {
  return {
    type: "engine/commandResult" as const,
    commandId,
    commandType: "composerOptions/load" as const,
    correlationId: "target-1",
    outcome: "failed" as const,
    errorMessage: "provider unavailable"
  };
}

const retryExpiry = {
  type: "engine/intentExpired" as const,
  expiryId: "composer-options-retry:target-1",
  dueAtUnixMs: 0
};

test("a non-4xx failure stays loading and schedules a bounded retry", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;

  // First failure: still loading, one retry scheduled.
  let result = composerOptionsReducer(state, failLoad("cmd-1"));
  state = result.state;
  assert.equal(state.entriesByTargetKey["target-1"]?.status, "loading");
  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["engine/scheduleExpiry"]
  );

  // The retry expiry re-issues the load with the original request payload.
  result = composerOptionsReducer(state, retryExpiry);
  state = result.state;
  assert.equal(result.commands.length, 1);
  const retryCommand = result.commands[0] as ComposerOptionsLoadCommand;
  assert.equal(retryCommand.type, "composerOptions/load");
  assert.equal(retryCommand.targetKey, "target-1");
  assert.equal(retryCommand.provider, "codex");
  assert.equal(retryCommand.workspaceId, "workspace-1");
  assert.equal(
    state.entriesByTargetKey["target-1"]?.inFlightCommandId,
    retryCommand.commandId
  );

  // Second failure: one more retry allowed.
  result = composerOptionsReducer(state, failLoad(retryCommand.commandId));
  state = result.state;
  assert.equal(state.entriesByTargetKey["target-1"]?.status, "loading");
  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["engine/scheduleExpiry"]
  );
  result = composerOptionsReducer(state, retryExpiry);
  state = result.state;
  const secondRetry = result.commands[0] as ComposerOptionsLoadCommand;
  assert.equal(secondRetry.type, "composerOptions/load");

  // Third failure: retries exhausted, terminal error, no further schedule.
  result = composerOptionsReducer(state, failLoad(secondRetry.commandId));
  state = result.state;
  assert.equal(result.commands.length, 0);
  assert.equal(state.entriesByTargetKey["target-1"]?.status, "error");
  assert.equal(state.entriesByTargetKey["target-1"]?.inFlightCommandId, null);
});

test("a successful retry resets the retry budget", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, failLoad("cmd-1")).state;
  let result = composerOptionsReducer(state, retryExpiry);
  state = result.state;
  const retryCommand = result.commands[0] as ComposerOptionsLoadCommand;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: retryCommand.commandId,
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options()
  }).state;
  assert.equal(state.entriesByTargetKey["target-1"]?.status, "ready");

  // A later forced load gets the full retry budget again.
  state = composerOptionsReducer(state, {
    ...loadRequest(true),
    commandId: "cmd-9"
  }).state;
  result = composerOptionsReducer(state, failLoad("cmd-9"));
  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["engine/scheduleExpiry"]
  );
});

test("a fresh request cancels a pending retry and a stale expiry is ignored", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, failLoad("cmd-1")).state;

  // A new user-driven request supersedes the retry-wait.
  let result = composerOptionsReducer(state, {
    ...loadRequest(true),
    commandId: "cmd-2"
  });
  state = result.state;
  assert.deepEqual(result.commands.map((command) => command.type).sort(), [
    "composerOptions/load",
    "engine/cancelExpiry"
  ]);

  // Even if a stale retry expiry still fires, no duplicate load is issued.
  result = composerOptionsReducer(state, retryExpiry);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state, state);
});

test("a timed out load schedules a retry", () => {
  const state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  const result = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "timedOut"
  });
  assert.equal(result.state.entriesByTargetKey["target-1"]?.status, "loading");
  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["engine/scheduleExpiry"]
  );
});

test("a cached ready result short-circuits an identical request", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options()
  }).state;
  const result = composerOptionsReducer(state, {
    ...loadRequest(),
    commandId: "cmd-2"
  });
  assert.equal(result.commands.length, 0);
  assert.equal(result.state, state);
});

test("an in-flight identical request is deduplicated", () => {
  const state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  const result = composerOptionsReducer(state, {
    ...loadRequest(),
    commandId: "cmd-2"
  });
  assert.equal(result.commands.length, 0);
});

test("force reloads even when a ready cache exists", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options()
  }).state;
  const result = composerOptionsReducer(state, {
    ...loadRequest(true),
    commandId: "cmd-2"
  });
  assert.equal(result.commands.length, 1);
  assert.equal(result.state.entriesByTargetKey["target-1"]?.status, "loading");
});

test("a superseded load result is ignored", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  // a newer forced request supersedes cmd-1
  state = composerOptionsReducer(state, {
    ...loadRequest(true),
    commandId: "cmd-2"
  }).state;
  const result = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options()
  });
  assert.equal(result.state, state);
});

test("invalidate clears cache validity so the next request refetches", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options()
  }).state;
  state = composerOptionsReducer(state, {
    type: "composerOptions/invalidated",
    providers: ["codex"]
  }).state;
  const result = composerOptionsReducer(state, {
    ...loadRequest(),
    commandId: "cmd-3"
  });
  assert.equal(result.commands.length, 1);
});

test("invalidate intersects provider and exact opaque target filters", () => {
  let state = createInitialComposerOptionsState();
  for (const [targetKey, provider, commandId] of [
    ["target-a", "codex", "cmd-a"],
    ["target-b", "codex", "cmd-b"],
    ["target-c", "claude-code", "cmd-c"]
  ] as const) {
    state = composerOptionsReducer(state, {
      ...loadRequest(),
      commandId,
      provider,
      targetKey
    }).state;
    state = composerOptionsReducer(state, {
      type: "engine/commandResult",
      commandId,
      commandType: "composerOptions/load",
      correlationId: targetKey,
      outcome: "succeeded",
      value: options({ provider })
    }).state;
  }

  state = composerOptionsReducer(state, {
    type: "composerOptions/invalidated",
    providers: ["codex"],
    targetKeys: ["target-a", "target-c"]
  }).state;

  assert.equal(state.entriesByTargetKey["target-a"]?.settledSignature, null);
  assert.notEqual(state.entriesByTargetKey["target-b"]?.settledSignature, null);
  assert.notEqual(state.entriesByTargetKey["target-c"]?.settledSignature, null);
});

test("invalidate lets an in-flight caller settle but forces the next refresh", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    type: "composerOptions/invalidated",
    providers: ["codex"]
  }).state;
  assert.equal(
    state.entriesByTargetKey["target-1"]?.inFlightCommandId,
    "cmd-1"
  );
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options()
  }).state;
  assert.equal(state.entriesByTargetKey["target-1"]?.status, "ready");
  assert.equal(state.entriesByTargetKey["target-1"]?.settledSignature, null);
  const refreshed = composerOptionsReducer(state, {
    ...loadRequest(),
    commandId: "cmd-2"
  });
  assert.equal(refreshed.commands.length, 1);
});

test("provider invalidation matches the active request instead of stale options", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options()
  }).state;
  state = composerOptionsReducer(state, {
    ...loadRequest(true),
    commandId: "cmd-2",
    provider: "claude-code"
  }).state;
  state = composerOptionsReducer(state, {
    type: "composerOptions/invalidated",
    providers: ["claude-code"]
  }).state;
  assert.equal(state.entriesByTargetKey["target-1"]?.loadingSignature, null);
});
