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
    runtimeContext: {
      configOptions: [
        {
          id: "fast",
          currentValue: "fast",
          options: [
            { name: "Standard", value: "standard" },
            { name: "Fast", value: "fast" }
          ]
        }
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
