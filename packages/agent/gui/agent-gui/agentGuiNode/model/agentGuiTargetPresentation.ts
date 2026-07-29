import type { AgentGUIAgentTarget } from "../../../types";
import type { AgentMessageMarkdownAgentTarget } from "../../../shared/AgentTargetPresentationContext";

export function agentTargetPresentationKey(
  agentTargets: readonly AgentGUIAgentTarget[]
): string {
  return JSON.stringify(
    agentTargets.map((target) => [
      target.agentTargetId ?? null,
      target.iconUrl ?? null,
      target.maskIconUrl ?? null,
      target.label,
      target.provider
    ])
  );
}

export function projectAgentTargetPresentations(input: {
  agentTargets: readonly AgentGUIAgentTarget[];
  workspaceId: string;
}): readonly AgentMessageMarkdownAgentTarget[] {
  return input.agentTargets.flatMap((target) =>
    target.agentTargetId
      ? [
          {
            agentTargetId: target.agentTargetId,
            iconUrl: target.iconUrl ?? null,
            maskIconUrl: target.maskIconUrl ?? null,
            name: target.label,
            provider: target.provider,
            workspaceId: input.workspaceId
          }
        ]
      : []
  );
}
