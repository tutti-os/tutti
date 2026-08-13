import { managedAgentRoundedIconUrl } from "./managedAgentIcons";

export interface AgentMessageMarkdownAgentTarget {
  agentTargetId: string;
  iconUrl?: string | null;
  maskIconUrl?: string | null;
  name?: string | null;
  provider?: string | null;
  workspaceId?: string | null;
}

export interface ResolvedAgentMentionTargetPresentation {
  iconUrl: string | undefined;
  name: string | undefined;
  provider: string | undefined;
  target: AgentMessageMarkdownAgentTarget | null;
}

export function resolveAgentTargetPresentation(input: {
  agentTargetId: string;
  agentTargets: readonly AgentMessageMarkdownAgentTarget[];
  workspaceId?: string | null;
}): AgentMessageMarkdownAgentTarget | null {
  const agentTargetId = input.agentTargetId.trim();
  if (!agentTargetId) {
    return null;
  }
  const workspaceId = input.workspaceId?.trim() ?? "";
  return (
    input.agentTargets.find(
      (target) =>
        target.agentTargetId.trim() === agentTargetId &&
        (target.workspaceId?.trim() ?? "") === workspaceId
    ) ??
    input.agentTargets.find(
      (target) => target.agentTargetId.trim() === agentTargetId
    ) ??
    null
  );
}

/**
 * Resolves every Agent mention surface from the same target directory.
 * Serialized mention metadata is only a fallback because it can outlive the
 * Agent directory entry that owns the current name, provider, and icon.
 */
export function resolveAgentMentionTargetPresentation(input: {
  agentTargetId?: string | null;
  agentTargets: readonly AgentMessageMarkdownAgentTarget[];
  fallbackIconUrl?: string | null;
  fallbackName?: string | null;
  fallbackProvider?: string | null;
  workspaceId?: string | null;
}): ResolvedAgentMentionTargetPresentation {
  const agentTargetId = input.agentTargetId?.trim() ?? "";
  const target = resolveAgentTargetPresentation({
    agentTargetId,
    agentTargets: input.agentTargets,
    workspaceId: input.workspaceId
  });
  const provider =
    target?.provider?.trim() || input.fallbackProvider?.trim() || undefined;
  return {
    iconUrl:
      target?.iconUrl?.trim() ||
      input.fallbackIconUrl?.trim() ||
      (provider ? managedAgentRoundedIconUrl(provider) : undefined),
    name: target?.name?.trim() || input.fallbackName?.trim() || undefined,
    provider,
    target
  };
}
