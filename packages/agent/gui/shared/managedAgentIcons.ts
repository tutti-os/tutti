import { agentColorfulUrl } from "../managedAgentIconAssets.ts";
import { migratedAgentGUIProviderIdentityCatalog } from "../providerIdentityCatalog.ts";
import { createProviderIconUrlMap } from "../providerIconAssets.ts";
import { normalizeManagedAgentProvider } from "./managedAgentProviders";

// `tutti` is a historical presentation alias rather than a provider id.
const managedAgentPresentationIconAliases = {
  tutti: "tutti"
} as const;

/** Square avatar art for the managed toolchain agents (used by Manage Agents and Launch home Agents floor). */
export const MANAGED_AGENT_ICON_URLS: Record<string, string> =
  createProviderIconUrlMap(
    "manage",
    managedAgentPresentationIconAliases,
    migratedAgentGUIProviderIdentityCatalog
  );

/** Colorful provider rail icons used by AgentGUI's left provider filter. */
export const MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS: Record<string, string> =
  createProviderIconUrlMap(
    "providerRail",
    managedAgentPresentationIconAliases,
    migratedAgentGUIProviderIdentityCatalog
  );

/** Rounded avatars for Room status / room activity panel only. */
export const MANAGED_AGENT_ICON_ROUNDED_URLS: Record<string, string> =
  createProviderIconUrlMap(
    "rounded",
    managedAgentPresentationIconAliases,
    migratedAgentGUIProviderIdentityCatalog
  );

/** Neutral artwork for UI surfaces that require a non-null fallback. */
export const MANAGED_AGENT_ICON_FALLBACK_URL = agentColorfulUrl;

export function managedAgentRoundedIconUrl(
  provider: string | undefined
): string {
  return (
    MANAGED_AGENT_ICON_ROUNDED_URLS[normalizeManagedAgentProvider(provider)] ??
    MANAGED_AGENT_ICON_FALLBACK_URL
  );
}
