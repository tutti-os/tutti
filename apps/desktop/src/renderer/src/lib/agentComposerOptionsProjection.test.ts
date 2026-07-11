import assert from "node:assert/strict";
import test from "node:test";
import { agentActivityComposerOptionsFromTuttidResult } from "./agentComposerOptionsProjection.ts";

test("agent composer options keep SDK fast speed configurable after reload", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("claude-code", {
    behavior: {
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
    modelOptionsAuthoritative: true,
    refreshModelOptionsAfterSettings: true,
    prewarmDraftSession: true,
    planModeExclusiveWithPermissionMode: true
  });
  assert.deepEqual(options.speeds, [
    { label: "Standard", value: "standard" },
    { label: "Fast", value: "fast" }
  ]);
  const runtimeContext = options.runtimeContext;
  assert.ok(runtimeContext);
  assert.equal(
    (runtimeContext.configOptions as Array<Record<string, unknown>>)[0]
      ?.currentValue,
    "fast"
  );
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
