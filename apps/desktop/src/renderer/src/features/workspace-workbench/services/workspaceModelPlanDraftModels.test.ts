import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyWorkspaceModelPlanDraftModel,
  reconcileWorkspaceModelPlanDraftModelsForPreset,
  removeWorkspaceModelPlanDraftModel,
  replaceWorkspaceModelPlanDraftModel
} from "./workspaceModelPlanDraftModels.ts";

test("a new model draft slot is blank and carries no implicit selection", () => {
  assert.deepEqual(createEmptyWorkspaceModelPlanDraftModel(), {
    id: "",
    name: ""
  });
});

test("the first explicit model selection becomes the default and replaces the full slot", () => {
  const replacement = {
    capabilities: ["reasoning", "vision"],
    id: "new-model",
    name: "New model",
    pricing: {
      cacheReadMicrosPerMillion: 1,
      cacheWriteMicrosPerMillion: 2,
      currency: "USD",
      inputMicrosPerMillion: 3,
      outputMicrosPerMillion: 4
    },
    tier: "flagship" as const
  };

  const result = replaceWorkspaceModelPlanDraftModel({
    defaultModel: "",
    index: 0,
    model: replacement,
    models: [
      {
        id: "",
        name: "",
        pricing: {
          cacheReadMicrosPerMillion: 90,
          cacheWriteMicrosPerMillion: 91,
          currency: "OLD",
          inputMicrosPerMillion: 92,
          outputMicrosPerMillion: 93
        },
        tier: "economy"
      }
    ]
  });

  assert.equal(result.defaultModel, "new-model");
  assert.deepEqual(result.models, [replacement]);
});

test("replacing the default repairs it to the first remaining selected model", () => {
  const result = replaceWorkspaceModelPlanDraftModel({
    defaultModel: "second",
    index: 1,
    model: { id: "replacement", name: "Replacement" },
    models: [
      { id: "first", name: "First" },
      { id: "second", name: "Second" }
    ]
  });

  assert.equal(result.defaultModel, "first");
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["first", "replacement"]
  );
});

test("replacing a slot with an id already selected in a sibling slot is rejected", () => {
  const result = replaceWorkspaceModelPlanDraftModel({
    defaultModel: "first",
    index: 1,
    model: { id: "first", name: "First again" },
    models: [
      { id: "first", name: "First" },
      { id: "second", name: "Second" }
    ]
  });

  assert.deepEqual(result.models, [
    { id: "first", name: "First" },
    { id: "second", name: "Second" }
  ]);
  assert.equal(result.defaultModel, "first");
});

test("re-selecting the same id into its own slot still replaces the slot", () => {
  const result = replaceWorkspaceModelPlanDraftModel({
    defaultModel: "first",
    index: 0,
    model: { id: "first", name: "First refreshed", tier: "flagship" },
    models: [
      { id: "first", name: "First" },
      { id: "second", name: "Second" }
    ]
  });

  assert.deepEqual(result.models[0], {
    id: "first",
    name: "First refreshed",
    tier: "flagship"
  });
  assert.equal(result.defaultModel, "first");
});

test("removing the default selects the first remaining model and removing all clears it", () => {
  const afterFirstRemoval = removeWorkspaceModelPlanDraftModel({
    defaultModel: "second",
    index: 1,
    models: [
      { id: "first", name: "First" },
      { id: "second", name: "Second" },
      { id: "third", name: "Third" }
    ]
  });
  assert.equal(afterFirstRemoval.defaultModel, "first");

  const afterAllRemoved = removeWorkspaceModelPlanDraftModel({
    defaultModel: "first",
    index: 0,
    models: [{ id: "first", name: "First" }]
  });
  assert.equal(afterAllRemoved.defaultModel, "");
  assert.deepEqual(afterAllRemoved.models, []);
});

test("switching preset retains only compatible selections without selecting the catalog", () => {
  const result = reconcileWorkspaceModelPlanDraftModelsForPreset({
    defaultModel: "compatible",
    models: [
      { id: "compatible", name: "Old compatible", tier: "economy" },
      { id: "incompatible", name: "Incompatible", tier: "flagship" }
    ],
    presetModels: [
      {
        capabilities: ["reasoning"],
        id: "compatible",
        name: "Current compatible",
        tier: "standard"
      },
      { id: "catalog-only", name: "Catalog only", tier: "flagship" }
    ]
  });

  assert.deepEqual(result, {
    defaultModel: "compatible",
    models: [
      {
        capabilities: ["reasoning"],
        id: "compatible",
        name: "Current compatible",
        tier: "standard"
      }
    ]
  });
});

test("switching to a preset without compatible models yields one blank slot", () => {
  assert.deepEqual(
    reconcileWorkspaceModelPlanDraftModelsForPreset({
      defaultModel: "old",
      models: [{ id: "old", name: "Old" }],
      presetModels: []
    }),
    {
      defaultModel: "",
      models: [{ id: "", name: "" }]
    }
  );
});
