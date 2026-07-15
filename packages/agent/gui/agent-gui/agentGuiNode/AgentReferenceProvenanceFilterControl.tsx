import { ReferenceProvenanceFilterControl } from "@tutti-os/workspace-file-reference/ui";
import { translate } from "../../i18n/index";
import type { AgentComposerReferenceProvenanceFilter } from "./composer/AgentComposer.types";

export function AgentReferenceProvenanceFilterControl({
  filter
}: {
  filter: AgentComposerReferenceProvenanceFilter;
}): React.JSX.Element {
  return (
    <ReferenceProvenanceFilterControl
      agentOptions={filter.snapshot.catalog.agentOptions}
      enabledDimensions={filter.snapshot.catalog.enabledDimensions}
      labels={{
        allAgents: translate("agentHost.agentGui.provenanceFilterAllAgents"),
        allMembers: translate("agentHost.agentGui.provenanceFilterAllMembers"),
        allSources: translate("agentHost.agentGui.provenanceFilterAllSources"),
        agents: translate("agentHost.agentGui.provenanceFilterAgents"),
        filteredSources: translate(
          "agentHost.agentGui.provenanceFilterFilteredSources"
        ),
        members: translate("agentHost.agentGui.provenanceFilterMembers"),
        reset: translate("agentHost.agentGui.provenanceFilterReset")
      }}
      memberOptions={filter.snapshot.catalog.memberOptions}
      value={filter.snapshot.value}
      onReset={filter.controller.reset}
      onToggle={filter.controller.toggle}
      onToggleAll={filter.controller.toggleAll}
    />
  );
}
