import assert from "node:assert/strict";
import test from "node:test";
import { toWorkspaceModelPlanPresetModels } from "./workspaceModelPlanTemplates.ts";

test("common preset models include an educational capability tier", () => {
  const models = toWorkspaceModelPlanPresetModels({
    apiKeyUrl: null,
    baseUrl: "",
    id: "tier-examples",
    labelKey: "workspace.settings.apps.modelPlans.presets.customOpenai",
    models: [
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "gpt-5.4-mini"
    ],
    protocol: "openai",
    protocolLocked: false
  });

  assert.equal(
    models.find((model) => model.id === "claude-opus-4-8")?.tier,
    "flagship"
  );
  assert.equal(
    models.find((model) => model.id === "claude-sonnet-4-6")?.tier,
    "standard"
  );
  assert.equal(
    models.find((model) => model.id === "claude-haiku-4-5")?.tier,
    "economy"
  );
  assert.equal(
    models.find((model) => model.id === "gpt-5.4-mini")?.tier,
    "economy"
  );
});
