import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderComposerOptionsResponse } from "@tutti-os/client-tuttid-ts";
import { agentActivityComposerOptionsFromTuttidResult } from "./composerOptions.ts";

test("maps daemon composer options into the canonical activity contract", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("codex", {
    codexSaverModeSupported: true,
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: true,
      planModeExclusiveWithPermissionMode: false,
      prewarmDraftSession: false,
      refreshModelOptionsAfterSettings: true
    },
    effectiveSettings: { codexSaverMode: true, model: "gpt-5" },
    modelConfig: {
      configurable: true,
      effectiveValue: "claude-haiku-4-5-20251001",
      options: [{ id: "gpt-5", label: "GPT-5", value: "gpt-5" }]
    },
    permissionConfig: { configurable: false, modes: [] },
    reasoningConfig: { configurable: false, options: [] },
    reasoningOptionsByModel: {},
    runtimeContext: {},
    commands: [],
    skills: [],
    capabilityCatalog: [],
    provider: "codex"
  } satisfies AgentProviderComposerOptionsResponse);

  assert.equal(options.provider, "codex");
  assert.equal(options.codexSaverModeSupported, true);
  assert.equal(options.effectiveSettings?.codexSaverMode, true);
  assert.equal(options.modelConfigurable, true);
  assert.equal(options.effectiveModel, "claude-haiku-4-5-20251001");
  assert.deepEqual(options.models, [{ label: "GPT-5", value: "gpt-5" }]);
  assert.equal(options.effectiveSettings?.model, "gpt-5");
});

test("keeps fallback slash commands when effects are absent", () => {
  const response = {
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: false,
      planModeExclusiveWithPermissionMode: false,
      prewarmDraftSession: false,
      refreshModelOptionsAfterSettings: false
    },
    capabilityCatalog: [],
    commands: [],
    effectiveSettings: {},
    modelConfig: { configurable: false, options: [] },
    permissionConfig: { configurable: false, modes: [] },
    provider: "acp:hermes",
    reasoningConfig: { configurable: false, options: [] },
    reasoningOptionsByModel: {},
    runtimeContext: {},
    skills: [],
    slashCommandPolicy: {
      fallbackCommands: ["compact", "help"]
    }
  } as unknown as AgentProviderComposerOptionsResponse;
  const options = agentActivityComposerOptionsFromTuttidResult(
    "acp:hermes",
    response
  );

  assert.deepEqual(options.slashCommandPolicy, {
    fallbackCommands: ["compact", "help"],
    commandEffects: []
  });
});

test("projects connector presentation icons from the daemon catalog", () => {
  const response = {
    behavior: {},
    capabilityCatalog: [
      {
        id: "connector:github",
        kind: "connector",
        name: "github",
        label: "GitHub",
        status: "available",
        invocation: "textTrigger",
        iconUrl: "data:image/png;base64,Z2l0aHVi",
        installedAtUnixMs: 1_786_089_600_000,
        trigger: "/github"
      }
    ],
    commands: [],
    effectiveSettings: {},
    modelConfig: { configurable: false, options: [] },
    permissionConfig: { configurable: false, modes: [] },
    provider: "codex",
    reasoningConfig: { configurable: false, options: [] },
    reasoningOptionsByModel: {},
    runtimeContext: {},
    skills: []
  } as unknown as AgentProviderComposerOptionsResponse;

  const options = agentActivityComposerOptionsFromTuttidResult(
    "codex",
    response
  );

  assert.equal(
    options.capabilityCatalog?.[0]?.iconUrl,
    "data:image/png;base64,Z2l0aHVi"
  );
  assert.equal(
    options.capabilityCatalog?.[0]?.installedAtUnixMs,
    1_786_089_600_000
  );
});
