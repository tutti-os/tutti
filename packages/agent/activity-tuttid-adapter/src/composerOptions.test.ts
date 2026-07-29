import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderComposerOptionsResponse } from "@tutti-os/client-tuttid-ts";
import { agentActivityComposerOptionsFromTuttidResult } from "./composerOptions.ts";

test("maps daemon composer options into the canonical activity contract", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("codex", {
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: true,
      planModeExclusiveWithPermissionMode: false,
      prewarmDraftSession: false,
      refreshModelOptionsAfterSettings: true
    },
    effectiveSettings: { model: "gpt-5" },
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
    capabilityCatalog: [
      {
        id: "plugin:browser@openai-bundled",
        kind: "plugin",
        name: "browser",
        label: "Browser",
        status: "available",
        invocation: "promptItem",
        semantic: "browserUse"
      }
    ],
    provider: "codex"
  } satisfies AgentProviderComposerOptionsResponse);

  assert.equal(options.provider, "codex");
  assert.equal(options.modelConfigurable, true);
  assert.equal(options.effectiveModel, "claude-haiku-4-5-20251001");
  assert.deepEqual(options.models, [{ label: "GPT-5", value: "gpt-5" }]);
  assert.equal(options.effectiveSettings?.model, "gpt-5");
  assert.deepEqual(options.capabilityCatalog, [
    {
      id: "plugin:browser@openai-bundled",
      kind: "plugin",
      name: "browser",
      label: "Browser",
      status: "available",
      invocation: "promptItem",
      semantic: "browserUse"
    }
  ]);
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
