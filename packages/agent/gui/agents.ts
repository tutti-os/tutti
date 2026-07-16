import type {
  AgentGUIAgent,
  AgentGUIAgentAvailabilityStatus,
  AgentGUIAgentTarget
} from "./types.ts";

export function normalizeAgentGUIAgents(
  agents: readonly AgentGUIAgent[] | null | undefined
): AgentGUIAgent[] {
  const normalized: AgentGUIAgent[] = [];
  const seenAgentTargetIds = new Set<string>();
  for (const agent of agents ?? []) {
    const agentTargetId = agent.agentTargetId.trim();
    const name = agent.name.trim();
    const iconUrl = agent.iconUrl.trim();
    const heroImageUrl = agent.heroImageUrl?.trim() ?? "";
    if (
      !agentTargetId ||
      !name ||
      !iconUrl ||
      seenAgentTargetIds.has(agentTargetId)
    ) {
      continue;
    }
    seenAgentTargetIds.add(agentTargetId);
    const ownerName = agent.owner?.name?.trim() ?? "";
    const ownerAvatarUrl = agent.owner?.avatarUrl?.trim() ?? "";
    const reason = agent.availability.reason?.trim() ?? "";
    normalized.push({
      agentTargetId,
      name,
      iconUrl,
      ...(heroImageUrl ? { heroImageUrl } : {}),
      ...(agent.description?.trim()
        ? { description: agent.description.trim() }
        : {}),
      ...(ownerName || ownerAvatarUrl
        ? {
            owner: {
              ...(ownerName ? { name: ownerName } : {}),
              ...(ownerAvatarUrl ? { avatarUrl: ownerAvatarUrl } : {})
            }
          }
        : {}),
      availability: {
        status: normalizeAgentGUIAgentAvailabilityStatus(
          agent.availability.status
        ),
        ...(reason ? { reason } : {}),
        ...(agent.availability.pendingAction
          ? { pendingAction: agent.availability.pendingAction }
          : {})
      },
      provider: agent.provider
    });
  }
  return normalized;
}

export function agentGUIAgentIsReady(agent: AgentGUIAgent): boolean {
  return agent.availability.status === "ready";
}

export function resolveAgentGUISelectedDirectoryAgent(input: {
  agents: readonly AgentGUIAgent[];
  agentTargetId?: string | null;
  defaultAgentTargetId?: string | null;
}): AgentGUIAgent | null {
  const explicitAgentTargetId =
    input.agentTargetId?.trim() || input.defaultAgentTargetId?.trim() || "";
  if (explicitAgentTargetId) {
    return (
      input.agents.find(
        (agent) => agent.agentTargetId === explicitAgentTargetId
      ) ?? null
    );
  }
  return (
    input.agents.find((agent) => agentGUIAgentIsReady(agent)) ??
    input.agents[0] ??
    null
  );
}

/** Package-internal bridge while the carried node is migrated to agent names. */
export function projectAgentGUIAgentsToInternalTargets(
  agents: readonly AgentGUIAgent[]
): AgentGUIAgentTarget[] {
  return agents.map((agent) => ({
    targetId: agent.agentTargetId,
    agentTargetId: agent.agentTargetId,
    provider: agent.provider,
    ref: {
      kind: "agent-directory",
      provider: agent.provider,
      agentTargetId: agent.agentTargetId
    },
    label: agent.name,
    availability: agent.availability,
    ...(agent.description ? { description: agent.description } : {}),
    iconUrl: agent.iconUrl,
    ...(agent.heroImageUrl ? { heroImageUrl: agent.heroImageUrl } : {}),
    ...(agent.owner?.avatarUrl
      ? {
          badge: {
            iconUrl: agent.owner.avatarUrl,
            ...(agent.owner.name ? { label: agent.owner.name } : {})
          }
        }
      : {}),
    ...(agent.owner?.name ? { ownerLabel: agent.owner.name } : {}),
    ...(agent.availability.status !== "ready" ? { disabled: true } : {}),
    ...(agent.availability.reason
      ? { unavailableReason: agent.availability.reason }
      : {})
  }));
}

function normalizeAgentGUIAgentAvailabilityStatus(
  status: AgentGUIAgentAvailabilityStatus
): AgentGUIAgentAvailabilityStatus {
  switch (status) {
    case "ready":
    case "checking":
    case "coming_soon":
    case "not_installed":
    case "auth_required":
    case "unavailable":
      return status;
  }
}
