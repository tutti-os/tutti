import { useReferenceProvenanceFilterCatalog } from "@tutti-os/workspace-file-reference/react";
import type { ReferenceProvenanceCatalog } from "@tutti-os/workspace-file-reference/contracts";
import type { AgentComposerReferenceProvenanceFilters } from "./AgentComposer.types";

const DISABLED_REFERENCE_PROVENANCE_CATALOG: ReferenceProvenanceCatalog = {
  enabledDimensions: [],
  agentOptions: [],
  memberOptions: []
};

export function useAgentMentionProvenanceFilters(
  catalog: ReferenceProvenanceCatalog | null
): AgentComposerReferenceProvenanceFilters | null {
  const effectiveCatalog = catalog ?? DISABLED_REFERENCE_PROVENANCE_CATALOG;
  const session = useReferenceProvenanceFilterCatalog(effectiveCatalog);
  const file = useReferenceProvenanceFilterCatalog(effectiveCatalog);
  const issue = useReferenceProvenanceFilterCatalog(effectiveCatalog);
  const agent = useReferenceProvenanceFilterCatalog(effectiveCatalog);
  const app = useReferenceProvenanceFilterCatalog(effectiveCatalog);

  if (session.snapshot.catalog.enabledDimensions.length === 0) {
    return null;
  }

  return {
    byFilter: {
      session,
      file,
      issue,
      agent,
      app
    }
  };
}
