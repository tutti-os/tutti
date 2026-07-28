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
  assert.equal(options.modelConfigurable, true);
  assert.deepEqual(options.models, [{ label: "GPT-5", value: "gpt-5" }]);
  assert.equal(options.effectiveSettings?.model, "gpt-5");
});
