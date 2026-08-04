import type { AgentGUIAgentTarget } from "../../../types";

export interface AgentGUIAgentTargetNamePresentation {
  agentLabel: string;
  fullLabel: string;
  ownerLabel: string | null;
  ownerSeparator: string;
}

export function projectAgentGUIAgentTargetName(input: {
  ownerSeparator: string;
  target: AgentGUIAgentTarget;
}): AgentGUIAgentTargetNamePresentation {
  const agentLabel = input.target.label.trim();
  const ownerLabel =
    input.target.ownership === "shared"
      ? input.target.ownerLabel?.trim() || null
      : null;
  const ownerSeparator = ownerLabel ? input.ownerSeparator : "";
  return {
    agentLabel,
    fullLabel: ownerLabel
      ? `${ownerLabel}${ownerSeparator}${agentLabel}`
      : agentLabel,
    ownerLabel,
    ownerSeparator
  };
}
