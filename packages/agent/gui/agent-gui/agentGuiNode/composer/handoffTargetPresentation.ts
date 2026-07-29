import type { AgentGUIAgentTarget } from "../../../types";

export interface HandoffTargetOwnershipLabels {
  self: string;
  shared: string;
}

export function resolveHandoffTargetOwnershipLabel(
  target: Pick<AgentGUIAgentTarget, "ownerLabel" | "ownership">,
  labels: HandoffTargetOwnershipLabels
): string | null {
  const ownerLabel = target.ownerLabel?.trim() ?? "";
  if (target.ownership === "self") {
    return labels.self;
  }
  if (target.ownership === "shared") {
    return ownerLabel ? `${ownerLabel} · ${labels.shared}` : labels.shared;
  }
  return null;
}
