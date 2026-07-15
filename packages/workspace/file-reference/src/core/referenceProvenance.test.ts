import assert from "node:assert/strict";
import { test } from "node:test";

import { createReferenceProvenanceFilterController } from "../react/internal/reference/referenceProvenanceFilterController.ts";
import {
  normalizeReferenceProvenanceCatalog,
  normalizeReferenceProvenanceFilter,
  referenceProvenanceFilterCacheKey,
  toggleReferenceProvenanceFilterId
} from "./referenceProvenance.ts";

const catalog = {
  enabledDimensions: ["agent"] as const,
  agentOptions: [
    { id: "agent-a", label: "Agent A" },
    { id: "agent-b", label: "Agent B" }
  ],
  memberOptions: []
};

test("provenance filter normalizes injected ids against the catalog", () => {
  assert.deepEqual(
    normalizeReferenceProvenanceFilter(
      {
        agentTargetIds: ["agent-b", "missing", "agent-b"],
        memberIds: ["member-a"]
      },
      catalog
    ),
    { agentTargetIds: ["agent-b"], memberIds: null }
  );
});

test("provenance controller callbacks remain valid when passed unbound to UI", () => {
  const controller = createReferenceProvenanceFilterController(catalog);
  const toggle = controller.toggle;
  const reset = controller.reset;

  toggle("agent", "agent-a");
  assert.deepEqual(controller.getSnapshot().value.agentTargetIds, ["agent-b"]);
  assert.equal(
    referenceProvenanceFilterCacheKey(controller.getSnapshot().value),
    '{"agentTargetIds":["agent-b"],"memberIds":null}'
  );

  reset();
  assert.equal(controller.getSnapshot().value.agentTargetIds, null);
});

test("provenance catalog owns normalized option identity", () => {
  assert.deepEqual(
    normalizeReferenceProvenanceCatalog({
      enabledDimensions: ["agent", "agent"],
      agentOptions: [
        { id: " agent-a ", label: "Agent A" },
        { id: "agent-a", label: "Duplicate" },
        { id: " ", label: "Missing" }
      ],
      memberOptions: []
    }),
    {
      enabledDimensions: ["agent"],
      agentOptions: [{ id: "agent-a", label: "Agent A" }],
      memberOptions: []
    }
  );
});

test("provenance cache keys cannot collide through comma-delimited ids", () => {
  assert.notEqual(
    referenceProvenanceFilterCacheKey({
      agentTargetIds: ["a,b", "c"],
      memberIds: null
    }),
    referenceProvenanceFilterCacheKey({
      agentTargetIds: ["a", "b,c"],
      memberIds: null
    })
  );
});

test("provenance transitions compose from the latest filter", () => {
  const first = toggleReferenceProvenanceFilterId(
    { agentTargetIds: null, memberIds: null },
    catalog,
    "agent",
    "agent-a"
  );
  const second = toggleReferenceProvenanceFilterId(
    first,
    catalog,
    "agent",
    "agent-b"
  );
  assert.deepEqual(second.agentTargetIds, []);
});
