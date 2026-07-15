import assert from "node:assert/strict";
import { test } from "node:test";

import { createReferenceProvenanceFilterController } from "../react/internal/reference/referenceProvenanceFilterController.ts";
import {
  normalizeReferenceProvenanceFilter,
  referenceProvenanceFilterCacheKey
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
    "agents:agent-b|members:*"
  );

  reset();
  assert.equal(controller.getSnapshot().value.agentTargetIds, null);
});
