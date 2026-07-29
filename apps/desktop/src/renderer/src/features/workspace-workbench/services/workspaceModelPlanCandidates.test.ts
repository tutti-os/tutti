import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspaceModelPlanCandidateCatalog,
  createCustomWorkspaceModelPlanCandidate,
  workspaceModelPlanCandidatesForSlot
} from "./workspaceModelPlanCandidates.ts";

test("candidate catalog combines preset and discovered models without turning them into selections", () => {
  const catalog = buildWorkspaceModelPlanCandidateCatalog(
    [
      { id: "preset-only", name: "preset-only", tier: "economy" },
      { id: "shared", name: "shared", tier: "standard" }
    ],
    [
      {
        capabilities: ["reasoning"],
        id: "shared",
        name: "Shared model",
        pricing: {
          cacheReadMicrosPerMillion: 1,
          cacheWriteMicrosPerMillion: 2,
          currency: "USD",
          inputMicrosPerMillion: 3,
          outputMicrosPerMillion: 4
        },
        tier: "flagship"
      },
      { id: "discovered-only", name: "Discovered only" }
    ]
  );

  assert.deepEqual(
    catalog.map((model) => model.id),
    ["preset-only", "shared", "discovered-only"]
  );
  assert.deepEqual(catalog[1], {
    capabilities: ["reasoning"],
    id: "shared",
    name: "Shared model",
    pricing: {
      cacheReadMicrosPerMillion: 1,
      cacheWriteMicrosPerMillion: 2,
      currency: "USD",
      inputMicrosPerMillion: 3,
      outputMicrosPerMillion: 4
    },
    tier: "flagship"
  });
});

test("slot candidates exclude models selected in other slots but retain the current model", () => {
  const catalog = [
    { id: "one", name: "One" },
    { id: "two", name: "Two" },
    { id: "three", name: "Three" }
  ];
  const selected = [catalog[0]!, catalog[1]!];

  assert.deepEqual(
    workspaceModelPlanCandidatesForSlot(catalog, selected, 0).map(
      (model) => model.id
    ),
    ["one", "three"]
  );
});

test("custom model candidate trims the typed id and starts without stale metadata", () => {
  assert.deepEqual(createCustomWorkspaceModelPlanCandidate("  private-v2  "), {
    id: "private-v2",
    name: "private-v2"
  });
  assert.equal(createCustomWorkspaceModelPlanCandidate("   "), null);
});
