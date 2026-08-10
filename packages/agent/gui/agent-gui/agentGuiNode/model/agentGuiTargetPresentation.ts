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
 * Transcript mentions are markdown links that only carry target id + workspace.
 * Icon lookup therefore needs every Agent the host can already hand off to, not
 * only the current directory rail. Local conversations that @ a shared Agent
 * otherwise miss the target and fall back to the colorful "all agents" glyph.
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

export function mentionAgentTargetPresentationKey(
  railTargets: readonly AgentGUIAgentTarget[],
  handoffTargets: readonly AgentGUIAgentTarget[] = []
): string {
  return agentTargetPresentationKey(
    mergeAgentTargetsForMentionPresentations(railTargets, handoffTargets)
  );
}

export function projectMentionAgentTargetPresentations(input: {
  handoffTargets?: readonly AgentGUIAgentTarget[];
  ownerSeparator: string;
  railTargets: readonly AgentGUIAgentTarget[];
  workspaceId: string;
}): readonly AgentMessageMarkdownAgentTarget[] {
  return projectAgentTargetPresentations({
    agentTargets: mergeAgentTargetsForMentionPresentations(
      input.railTargets,
      input.handoffTargets
    ),
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
