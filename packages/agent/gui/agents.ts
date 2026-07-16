import type {
  AgentGUIAgent,
  AgentGUIAgentAvailabilityStatus,
  AgentGUIAgentTarget
} from "./types.ts";
import {
  agentGUISharedAgentUnavailableReason,
  normalizeAgentGUISharedAgentAccess
} from "./sharedAgentAccess.ts";

export function normalizeAgentGUIAgents(
  agents: readonly AgentGUIAgent[] | null | undefined
): AgentGUIAgent[] {
  const normalized: AgentGUIAgent[] = [];
  const seenAgentTargetIds = new Set<string>();
  for (const agent of agents ?? []) {
    const agentTargetId = agent.agentTargetId.trim();
    const name = agent.name.trim();
    const iconUrl = agent.iconUrl.trim();
    const maskIconUrl = agent.maskIconUrl?.trim() ?? "";
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
    const ownerUserId = agent.owner?.userId?.trim() ?? "";
    const sharedAccess = normalizeAgentGUISharedAgentAccess(agent.sharedAccess);
    const sharedUnavailableReason =
      agentGUISharedAgentUnavailableReason(sharedAccess);
    const reason =
      sharedUnavailableReason ?? agent.availability.reason?.trim() ?? "";
    normalized.push({
      agentTargetId,
      name,
      iconUrl,
      ...(maskIconUrl ? { maskIconUrl } : {}),
      ...(heroImageUrl ? { heroImageUrl } : {}),
      ...(agent.description?.trim()
        ? { description: agent.description.trim() }
        : {}),
      ...(ownerUserId || ownerName || ownerAvatarUrl
        ? {
            owner: {
              ...(ownerUserId ? { userId: ownerUserId } : {}),
              ...(ownerName ? { name: ownerName } : {}),
              ...(ownerAvatarUrl ? { avatarUrl: ownerAvatarUrl } : {})
            }
          }
        : {}),
      ...(agent.ownership === "self" || agent.ownership === "shared"
        ? { ownership: agent.ownership }
        : {}),
      ...(sharedAccess ? { sharedAccess } : {}),
      availability: {
        status: sharedUnavailableReason
          ? "unavailable"
          : normalizeAgentGUIAgentAvailabilityStatus(agent.availability.status),
        ...(reason ? { reason } : {}),
        ...(agent.availability.pendingAction
          ? { pendingAction: agent.availability.pendingAction }
          : {})
      },
      provider: agent.provider,
      ...(agent.setupKind === "target_runtime"
        ? { setupKind: "target_runtime" as const }
        : {})
    });
  }
  return normalized;
}

export function agentGUIAgentIsReady(agent: AgentGUIAgent): boolean {
  return (
    agent.availability.status === "ready" &&
    agentGUISharedAgentUnavailableReason(agent.sharedAccess) === null
  );
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

/** Projects the canonical Agent directory into target rows for selection menus. */
export function projectAgentGUIAgentsToTargets(
  agents: readonly AgentGUIAgent[]
): AgentGUIAgentTarget[] {
  return agents.map((agent) => {
    const unavailableReason =
      agentGUISharedAgentUnavailableReason(agent.sharedAccess) ??
      agent.availability.reason?.trim() ??
      "";
    return {
      targetId: agent.agentTargetId,
      agentTargetId: agent.agentTargetId,
      provider: agent.provider,
      ref: {
        kind: "agent-directory",
        provider: agent.provider,
        agentTargetId: agent.agentTargetId,
        ...(agent.sharedAccess ? { sharedAccess: agent.sharedAccess } : {}),
        ...(agent.setupKind ? { setupKind: agent.setupKind } : {})
      },
      label: agent.name,
      availability: agent.availability,
      ...(agent.description ? { description: agent.description } : {}),
      iconUrl: agent.iconUrl,
      ...(agent.maskIconUrl ? { maskIconUrl: agent.maskIconUrl } : {}),
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
      ...(agent.ownership ? { ownership: agent.ownership } : {}),
      ...(agent.setupKind ? { setupKind: agent.setupKind } : {}),
      ...(!agentGUIAgentIsReady(agent) && !agent.setupKind
        ? { disabled: true }
        : {}),
      ...(unavailableReason ? { unavailableReason } : {})
    };
  });
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
