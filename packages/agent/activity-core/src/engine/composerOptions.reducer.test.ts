import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityComposerOptions,
  AgentActivitySession
} from "../types.ts";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
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

test("a different Session identity does not reuse a settled capabilities catalog", () => {
  let state = composerOptionsReducer(createInitialComposerOptionsState(), {
    ...loadRequest(),
    agentSessionId: "session-a",
    section: "capabilities"
  }).state;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1::capabilities",
    outcome: "succeeded",
    value: options({
      skills: [
        {
          kind: "skill",
          name: "session-a-skill",
          sourceKind: "personal",
          trigger: "$session-a-skill"
        }
      ]
    })
  }).state;

  const result = composerOptionsReducer(state, {
    ...loadRequest(),
    agentSessionId: "session-b",
    commandId: "cmd-2",
    section: "capabilities"
  });

  assert.equal(result.commands.length, 1);
  assert.equal(
    (result.commands[0] as ComposerOptionsLoadCommand).agentSessionId,
    "session-b"
  );
});

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
    value: options({ codexSaverModeSupported: true })
  }).state;
  assert.equal(state.entriesByTargetKey["target-1"]?.status, "ready");
  assert.equal(state.optionsByTargetKey["target-1"]?.provider, "codex");
  assert.equal(
    state.optionsByTargetKey["target-1"]?.codexSaverModeSupported,
    true
  );
});

test("a failed load reaches a terminal error state", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "failed",
    errorMessage: "provider unavailable"
  }).state;
  assert.equal(state.entriesByTargetKey["target-1"]?.status, "error");
  assert.equal(state.entriesByTargetKey["target-1"]?.inFlightCommandId, null);
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

test("force joins an identical in-flight request", () => {
  const state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  const result = composerOptionsReducer(state, {
    ...loadRequest(true),
    commandId: "cmd-2"
  });
  assert.equal(result.commands.length, 0);
  assert.equal(result.state, state);
});

test("validated settings success refreshes provider-declared target options", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: options({
      behavior: {
        refreshModelOptionsAfterSettings: true
      } as AgentActivityComposerOptions["behavior"]
    })
  }).state;
  const session = settingsSession();
  const refreshed = composerOptionsReducer(
    state,
    {
      commandId: "settings-1",
      commandType: "session/updateSettings",
      correlationId: "session-1",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: { agentSessionId: "session-1", session }
    },
    { settingsResultValidation: { kind: "valid", session } }
  );

  assert.deepEqual(refreshed.commands, [
    {
      agentSessionId: "session-1",
      commandId: "composer-options:after-settings:settings-1",
      correlationId: "target-1::core",
      cwd: "/workspace",
      provider: "codex",
      section: "core",
      settings: {
        model: "model-2",
        permissionModeId: "acceptEdits",
        planMode: true,
        reasoningEffort: "high",
        speed: "fast"
      },
      targetKey: "target-1",
      type: "composerOptions/load",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    refreshed.state.entriesByTargetKey["target-1"]?.status,
    "loading"
  );
});

test("settings success does not refresh options when provider behavior disables it", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: options({
      behavior: {
        refreshModelOptionsAfterSettings: false
      } as AgentActivityComposerOptions["behavior"]
    })
  }).state;
  const session = settingsSession();
  const unchanged = composerOptionsReducer(
    state,
    {
      commandId: "settings-1",
      commandType: "session/updateSettings",
      correlationId: "session-1",
      outcome: "succeeded",
      type: "engine/commandResult"
    },
    { settingsResultValidation: { kind: "valid", session } }
  );

  assert.equal(unchanged.state, state);
  assert.deepEqual(unchanged.commands, []);
});

test("a superseded load result is ignored", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  // A newer forced request with a different semantic signature supersedes
  // cmd-1. An identical forced request is intentionally joined instead.
  state = composerOptionsReducer(state, {
    ...loadRequest(true),
    cwd: "/workspace/new",
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

test("a late result from an older project request cannot overwrite the current target scope", () => {
  let state = composerOptionsReducer(createInitialComposerOptionsState(), {
    ...loadRequest(),
    cwd: "/workspace/old"
  }).state;
  state = composerOptionsReducer(state, {
    ...loadRequest(),
    commandId: "cmd-2",
    cwd: "/workspace/new"
  }).state;

  const stale = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options({ models: [{ value: "stale-model", label: "Stale" }] })
  });

  assert.equal(stale.state, state);
  assert.equal(stale.state.optionsByTargetKey["target-1"], undefined);
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

test("target invalidation only clears the exact target and is harmless when repeated", () => {
  let state = composerOptionsReducer(
    createInitialComposerOptionsState(),
    loadRequest()
  ).state;
  state = composerOptionsReducer(state, {
    ...loadRequest(),
    commandId: "cmd-2",
    targetKey: "target-2"
  }).state;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-1",
    commandType: "composerOptions/load",
    correlationId: "target-1",
    outcome: "succeeded",
    value: options()
  }).state;
  state = composerOptionsReducer(state, {
    type: "engine/commandResult",
    commandId: "cmd-2",
    commandType: "composerOptions/load",
    correlationId: "target-2",
    outcome: "succeeded",
    value: options()
  }).state;

  state = composerOptionsReducer(state, {
    type: "composerOptions/invalidated",
    targetKeys: ["target-1"]
  }).state;
  assert.equal(state.entriesByTargetKey["target-1"]?.settledSignature, null);
  assert.notEqual(state.entriesByTargetKey["target-2"]?.settledSignature, null);
  const repeated = composerOptionsReducer(state, {
    type: "composerOptions/invalidated",
    targetKeys: ["target-1"]
  }).state;
  assert.equal(repeated.entriesByTargetKey["target-1"]?.settledSignature, null);
});

function settingsSession(): AgentActivitySession {
  return normalizeAgentActivitySession({
    activeTurn: null,
    activeTurnId: null,
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    settings: {
      model: "model-2",
      permissionModeId: "acceptEdits",
      planMode: true,
      reasoningEffort: "high",
      speed: "fast"
    },
    title: "Session",
    updatedAtUnixMs: 2,
    workspaceId: "workspace-1"
  });
}
