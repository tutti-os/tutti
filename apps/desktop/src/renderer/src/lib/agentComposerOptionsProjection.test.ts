import assert from "node:assert/strict";
import test from "node:test";
import { agentActivityComposerOptionsFromTuttidResult } from "./agentComposerOptionsProjection.ts";

test("agent composer options keep SDK fast speed configurable after reload", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("claude-code", {
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: true,
      refreshModelOptionsAfterSettings: true,
      prewarmDraftSession: true,
      planModeExclusiveWithPermissionMode: true
    },
    speedConfig: {
      configurable: true,
      currentValue: "fast",
      options: [
        { label: "Standard", value: "standard" },
        { label: "Fast", value: "fast" }
      ]
    }
  });

  assert.equal(options.speedConfigurable, true);
  assert.deepEqual(options.behavior, {
    collapseModelOptionsToLatest: false,
    modelOptionsAuthoritative: true,
    refreshModelOptionsAfterSettings: true,
    prewarmDraftSession: true,
    planModeExclusiveWithPermissionMode: true
  });
  assert.deepEqual(options.speeds, [
    { label: "Standard", value: "standard" },
    { label: "Fast", value: "fast" }
  ]);
  assert.equal("runtimeContext" in options, false);
});

test("agent composer options do not expand typed capabilities from runtime context", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("acp:gemini", {
    skills: [],
    capabilityCatalog: [],
    runtimeContext: {
      configOptions: [
        {
          id: "speed",
          currentValue: "poison",
          options: [{ name: "Poison", value: "poison" }]
        }
      ],
      skills: [
        {
          name: "Poison skill",
          trigger: "/poison",
          sourceKind: "plugin"
        }
      ],
      capabilityCatalog: [
        {
          id: "poison-plugin",
          invocation: "textTrigger",
          kind: "plugin",
          label: "Poison plugin",
          name: "poison-plugin",
          status: "available"
        }
      ]
    }
  });

  assert.deepEqual(options.skills, []);
  assert.deepEqual(options.capabilityCatalog, []);
  assert.deepEqual(options.speeds, []);
  assert.equal(options.speedConfigurable, false);
});

test("agent composer options preserve an advertised empty model reasoning profile", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("opencode", {
    modelConfig: {
      configurable: true,
      currentValue: "opencode/big-pickle",
      options: [{ label: "Big Pickle", value: "opencode/big-pickle" }]
    },
    reasoningConfig: { configurable: false, options: [] },
    effectiveSettings: { model: "opencode/big-pickle" },
    reasoningOptionsByModel: {
      "opencode/big-pickle": { defaultValue: null, options: [] }
    },
    runtimeContext: {
      modelReasoningOptionsByModel: {
        poison: { defaultValue: "poison", options: [] }
      }
    }
  });

  assert.deepEqual(options.reasoningOptionsByModel, {
    "opencode/big-pickle": { defaultValue: null, options: [] }
  });
  assert.equal(options.reasoningConfigurable, false);
});

test("agent composer options project the typed slash command policy", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("codex", {
    slashCommandPolicy: {
      fallbackCommands: ["compact", "status"],
      commandCatalogAuthoritative: true,
      commandEffects: [
        { command: "compact", effect: "submitImmediate" },
        { command: "status", effect: "showStatus" },
        { command: "goal", effect: "activateGoalMode" },
        { command: "poison", effect: "unknown" }
      ]
    },
    runtimeContext: {
      slashCommandPolicy: {
        fallbackCommands: ["legacy"],
        commandEffects: []
      }
    }
  });

  assert.deepEqual(options.slashCommandPolicy, {
    fallbackCommands: ["compact", "status"],
    commandCatalogAuthoritative: true,
    commandEffects: [
      { command: "compact", effect: "submitImmediate" },
      { command: "status", effect: "showStatus" },
      { command: "goal", effect: "activateGoalMode" }
    ]
  });
});

test("agent composer options restore commands advertised by a running ACP session", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("acp:gemini", {
    commands: [
      {
        name: "memory",
        description: "Manage memory",
        inputHint: "show | refresh"
      },
      { name: "help" },
      { name: "memory" },
      { description: "invalid" }
    ],
    runtimeContext: {
      availableCommands: [
        {
          name: "legacy-command-that-must-not-win"
        }
      ]
    }
  });

  assert.deepEqual(options.commands, [
    {
      name: "memory",
      description: "Manage memory",
      inputHint: "show | refresh"
    },
    { name: "help" }
  ]);
});

test("agent composer options project typed pre-session capabilities separately from the tool catalog", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("cursor", {
    capabilities: {
      activeTurnGuidance: false,
      browserUse: true,
      compact: false,
      computerUse: false,
      goalPause: false,
      imageInput: true,
      interrupt: true,
      modelImageInputRequired: true,
      permissionModeChangeDeferred: false,
      permissionModeChangeDuringTurn: false,
      planImplementation: false,
      planMode: true,
      rateLimits: false,
      resumeRunningTurn: false,
      review: false,
      skills: false,
      tokenUsage: false
    },
    capabilityCatalog: [
      {
        id: "cursor-plugin",
        invocation: "textTrigger",
        kind: "plugin",
        label: "Cursor plugin",
        name: "cursor-plugin",
        status: "available"
      }
    ]
  });

  assert.equal(options.capabilities?.planMode, true);
  assert.equal(options.capabilities?.browserUse, true);
  assert.deepEqual(
    options.capabilityCatalog?.map((entry) => entry.id),
    ["cursor-plugin"]
  );
});

test("agent composer options preserve effective pre-session settings", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("codex", {
    effectiveSettings: {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      speed: "fast",
      planMode: false,
      permissionModeId: "full-access"
    }
  });

  assert.deepEqual(options.effectiveSettings, {
    model: "gpt-5.3-codex",
    reasoningEffort: "high",
    speed: "fast",
    planMode: false,
    permissionModeId: "full-access"
  });
});

test("agent composer options keep requested-origin provenance on model entries", () => {
  // Warm-catalog window: the daemon appends the requested model with a
  // provenance marker; the projection must preserve it so the composer can
  // exclude the entry from catalog testimony. The projection-side
  // current-value append carries the same marker for the same reason.
  const options = agentActivityComposerOptionsFromTuttidResult("codex", {
    effectiveSettings: { model: "x-ai/grok-4.5" },
    modelConfig: {
      configurable: true,
      currentValue: "x-ai/grok-4.5",
      options: [
        { name: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
        { name: "GPT-5.6 Sol", value: "gpt-5.6-sol" },
        { name: "x-ai/grok-4.5", value: "x-ai/grok-4.5", requested: true }
      ]
    }
  });

  assert.deepEqual(options.models, [
    { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
    { label: "GPT-5.6 Sol", value: "gpt-5.6-sol" },
    { label: "x-ai/grok-4.5", value: "x-ai/grok-4.5", requested: true }
  ]);
});

test("agent composer options mark the projection-side current-value append as requested", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("codex", {
    modelConfig: {
      configurable: true,
      currentValue: "x-ai/grok-4.5",
      options: [{ label: "GPT-5.6 Sol", value: "gpt-5.6-sol" }]
    }
  });

  assert.deepEqual(options.models, [
    { label: "GPT-5.6 Sol", value: "gpt-5.6-sol" },
    { label: "x-ai/grok-4.5", value: "x-ai/grok-4.5", requested: true }
  ]);
});

test("agent composer options project model configuration without exposing runtime context", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("codex", {
    runtimeContext: {
      modelConfiguration: {
        agentTargetId: "local:codex",
        defaultModel: "gpt-5.5-codex",
        fingerprint: "plan-1:7",
        source: "model-plan"
      }
    }
  });

  assert.deepEqual(options.modelConfiguration, {
    agentTargetId: "local:codex",
    defaultModel: "gpt-5.5-codex",
    fingerprint: "plan-1:7",
    source: "model-plan"
  });
  assert.equal("runtimeContext" in options, false);
});
