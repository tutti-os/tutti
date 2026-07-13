import type {
  AgentGUIAgentTarget,
  AgentGUIAgentTargetBadge,
  AgentGUIProvider
} from "../../../types";
import {
  MANAGED_AGENT_ICON_FALLBACK_URL,
  MANAGED_AGENT_ICON_URLS,
  MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS
} from "../../../shared/managedAgentIcons";
import { normalizeManagedAgentProvider } from "../../../shared/managedAgentProviders";

/** Canonical visual projection consumed by every AgentGUI avatar renderer. */
export interface AgentGUIAgentAvatarPresentation {
  agentTargetId: string;
  badge?: AgentGUIAgentTargetBadge | null;
  disabled?: boolean;
  iconUrl: string;
  label: string;
  provider: AgentGUIProvider;
  targetId: string;
}

export function resolveAgentGUIHeroIconUrl(
  provider: string | undefined
): string {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  return (
    MANAGED_AGENT_ICON_URLS[normalizedProvider] ??
    MANAGED_AGENT_ICON_FALLBACK_URL
  );
}

export function resolveAgentGUIAgentAvatarIconUrl(
  provider: string | undefined,
  iconUrl?: string | null
): string {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  return (
    iconUrl?.trim() ||
    MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS[normalizedProvider] ||
    resolveAgentGUIHeroIconUrl(normalizedProvider)
  );
}

export function projectAgentGUIAgentTargetAvatar(
  target: AgentGUIAgentTarget
): AgentGUIAgentAvatarPresentation {
  return {
    targetId: target.targetId,
    agentTargetId: target.agentTargetId ?? target.targetId,
    provider: target.provider,
    label: target.label,
    iconUrl: resolveAgentGUIAgentAvatarIconUrl(target.provider, target.iconUrl),
    ...(target.badge ? { badge: target.badge } : {}),
    ...(target.disabled === true ? { disabled: true } : {})
  };
}

export function createFallbackAgentGUIAgentAvatar(input: {
  agentTargetId?: string | null;
  iconUrl?: string | null;
  label: string;
  provider: AgentGUIProvider;
}): AgentGUIAgentAvatarPresentation {
  const agentTargetId =
    input.agentTargetId?.trim() || `local:${input.provider}`;
  return {
    targetId: agentTargetId,
    agentTargetId,
    provider: input.provider,
    label: input.label,
    iconUrl: resolveAgentGUIAgentAvatarIconUrl(input.provider, input.iconUrl)
  };
}
