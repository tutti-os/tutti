import type { AgentGUIAgentTarget } from "../../../types";
import type { AgentMessageMarkdownAgentTarget } from "../../../shared/AgentTargetPresentationContext";
import { projectAgentGUIAgentTargetName } from "./agentGuiTargetName";

export function agentTargetPresentationKey(
  agentTargets: readonly AgentGUIAgentTarget[]
): string {
  return JSON.stringify(
    agentTargets.map((target) => [
      target.agentTargetId ?? null,
      target.iconUrl ?? null,
      target.maskIconUrl ?? null,
      target.label,
      target.ownerLabel ?? null,
      target.ownership ?? null,
      target.provider
    ])
  );
}

/**
 * Legacy hosts only expose action catalogs. Keep their transcript identity
 * lookup broad enough to cover both rail and handoff targets.
 */
export function mergeAgentTargetsForMentionPresentations(
  railTargets: readonly AgentGUIAgentTarget[],
  handoffTargets: readonly AgentGUIAgentTarget[] = []
): readonly AgentGUIAgentTarget[] {
  if (handoffTargets.length === 0) {
    return railTargets;
  }
  const byId = new Map<string, AgentGUIAgentTarget>();
  for (const target of railTargets) {
    const agentTargetId = target.agentTargetId?.trim();
    if (agentTargetId) {
      byId.set(agentTargetId, target);
    }
  }
  for (const target of handoffTargets) {
    const agentTargetId = target.agentTargetId?.trim();
    if (!agentTargetId || byId.has(agentTargetId)) {
      continue;
    }
    byId.set(agentTargetId, target);
  }
  return byId.size === railTargets.length ? railTargets : [...byId.values()];
}

export function resolveMentionAgentTargetsForPresentations(input: {
  handoffTargets?: readonly AgentGUIAgentTarget[];
  mentionTargets?: readonly AgentGUIAgentTarget[];
  railTargets: readonly AgentGUIAgentTarget[];
}): readonly AgentGUIAgentTarget[] {
  return (
    input.mentionTargets ??
    mergeAgentTargetsForMentionPresentations(
      input.railTargets,
      input.handoffTargets
    )
  );
}

export function mentionAgentTargetPresentationKey(
  railTargets: readonly AgentGUIAgentTarget[],
  handoffTargets: readonly AgentGUIAgentTarget[] = [],
  mentionTargets?: readonly AgentGUIAgentTarget[]
): string {
  return agentTargetPresentationKey(
    resolveMentionAgentTargetsForPresentations({
      handoffTargets,
      mentionTargets,
      railTargets
    })
  );
}

export function projectMentionAgentTargetPresentations(input: {
  handoffTargets?: readonly AgentGUIAgentTarget[];
  mentionTargets?: readonly AgentGUIAgentTarget[];
  ownerSeparator: string;
  railTargets: readonly AgentGUIAgentTarget[];
  workspaceId: string;
}): readonly AgentMessageMarkdownAgentTarget[] {
  return projectAgentTargetPresentations({
    agentTargets: resolveMentionAgentTargetsForPresentations(input),
    ownerSeparator: input.ownerSeparator,
    workspaceId: input.workspaceId
  });
}

export function projectAgentTargetPresentations(input: {
  agentTargets: readonly AgentGUIAgentTarget[];
  ownerSeparator: string;
  workspaceId: string;
}): readonly AgentMessageMarkdownAgentTarget[] {
  return input.agentTargets.flatMap((target) =>
    target.agentTargetId
      ? [
          {
            agentTargetId: target.agentTargetId,
            iconUrl: target.iconUrl ?? null,
            maskIconUrl: target.maskIconUrl ?? null,
            name: projectAgentGUIAgentTargetName({
              ownerSeparator: input.ownerSeparator,
              target
            }).fullLabel,
            provider: target.provider,
            workspaceId: input.workspaceId
          }
        ]
      : []
  );
}
