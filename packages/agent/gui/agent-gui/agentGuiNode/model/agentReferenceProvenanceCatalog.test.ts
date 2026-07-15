import { describe, expect, it } from "vitest";
import type { ReferenceProvenanceCatalog } from "@tutti-os/workspace-file-reference/contracts";
import { resolveAgentGUIReferenceProvenanceFilterCatalog } from "./agentReferenceProvenanceCatalog";

const AGENT_TARGET = {
  agentTargetId: " local:codex ",
  label: "Codex",
  provider: "codex" as const
} as const;

describe("resolveAgentGUIReferenceProvenanceFilterCatalog", () => {
  it("keeps provenance filtering disabled by default", () => {
    expect(
      resolveAgentGUIReferenceProvenanceFilterCatalog({
        agentTargets: [AGENT_TARGET],
        injectedCatalog: undefined,
        legacyAgentFilterEnabled: false
      })
    ).toBeNull();
  });

  it("preserves the legacy Agent-only catalog without enabling members", () => {
    expect(
      resolveAgentGUIReferenceProvenanceFilterCatalog({
        agentTargets: [AGENT_TARGET],
        injectedCatalog: undefined,
        legacyAgentFilterEnabled: true
      })
    ).toEqual({
      enabledDimensions: ["agent"],
      agentOptions: [
        {
          disabled: undefined,
          iconUrl: undefined,
          id: "local:codex",
          label: "Codex"
        }
      ],
      memberOptions: []
    });
  });

  it("uses the complete host catalog when one is explicitly injected", () => {
    const catalog: ReferenceProvenanceCatalog = {
      enabledDimensions: ["agent", "member"],
      agentOptions: [{ id: "shared:codex", label: "Shared Codex" }],
      memberOptions: [{ id: "member-1", label: "Ada" }]
    };

    expect(
      resolveAgentGUIReferenceProvenanceFilterCatalog({
        agentTargets: [AGENT_TARGET],
        injectedCatalog: catalog,
        legacyAgentFilterEnabled: false
      })
    ).toBe(catalog);
  });
});
