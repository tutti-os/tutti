import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReferenceProvenanceCatalog } from "@tutti-os/workspace-file-reference/contracts";
import { useAgentMentionProvenanceFilters } from "./useAgentMentionProvenanceFilters";

const AGENT_CATALOG: ReferenceProvenanceCatalog = {
  enabledDimensions: ["agent"],
  agentOptions: [{ id: "agent-1", label: "Agent 1" }],
  memberOptions: []
};
const INPUT = {
  agentTargets: null,
  injectedCatalog: AGENT_CATALOG,
  legacyAgentFilterEnabled: false
} as const;

describe("useAgentMentionProvenanceFilters", () => {
  it("preserves the combined binding identity when the catalog is unchanged", () => {
    const rendered = renderHook(
      ({ input }) => useAgentMentionProvenanceFilters(input),
      {
        initialProps: { input: INPUT }
      }
    );
    const initial = rendered.result.current;
    const initialSession = initial?.byFilter.session;

    rendered.rerender({ input: INPUT });

    expect(rendered.result.current?.byFilter.session).toBe(initialSession);
    expect(rendered.result.current).toBe(initial);
  });
});
