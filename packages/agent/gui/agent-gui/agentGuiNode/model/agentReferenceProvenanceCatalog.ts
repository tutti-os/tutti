import type { ReferenceProvenanceCatalog } from "@tutti-os/workspace-file-reference/contracts";
import type { AgentGUIAgentTarget } from "../../../types";

export function resolveAgentGUIReferenceProvenanceFilterCatalog(input: {
  agentTargets:
    | readonly Pick<
        AgentGUIAgentTarget,
        "agentTargetId" | "disabled" | "iconUrl" | "label"
      >[]
    | null
    | undefined;
  injectedCatalog: ReferenceProvenanceCatalog | null | undefined;
  legacyAgentFilterEnabled: boolean;
}): ReferenceProvenanceCatalog | null {
  if (input.injectedCatalog !== undefined) {
    return input.injectedCatalog;
  }
  if (!input.legacyAgentFilterEnabled) {
    return null;
  }
  return {
    enabledDimensions: ["agent"],
    agentOptions: (input.agentTargets ?? []).flatMap((target) => {
      const agentTargetId = target.agentTargetId?.trim();
      return agentTargetId
        ? [
            {
              disabled: target.disabled,
              iconUrl: target.iconUrl,
              id: agentTargetId,
              label: target.label
            }
          ]
        : [];
    }),
    memberOptions: []
  };
}
