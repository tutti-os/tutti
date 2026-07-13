import { migratedAgentGUIProviderIdentityCatalog } from "@tutti-os/agent-gui/provider-catalog";
import type {
  DesktopAgentProvider,
  DesktopDefaultAgentProvider
} from "../../../../../shared/preferences/index.ts";

export const workspaceSettingsDefaultAgentProviders =
  migratedAgentGUIProviderIdentityCatalog
    .filter((entry) => entry.desktop.defaultProviderEligible)
    .slice()
    .sort(
      (left, right) =>
        left.desktop.defaultProviderPriority -
        right.desktop.defaultProviderPriority
    )
    .map(
      (entry) => entry.providerId as DesktopDefaultAgentProvider
    ) satisfies readonly DesktopDefaultAgentProvider[];

const workspaceSettingsFallbackDefaultAgentProvider =
  requireFirstWorkspaceSettingsDefaultAgentProvider(
    workspaceSettingsDefaultAgentProviders
  );

export function normalizeWorkspaceSettingsDefaultAgentProvider(
  provider: DesktopAgentProvider
): DesktopDefaultAgentProvider {
  const candidate = provider as DesktopDefaultAgentProvider;
  return workspaceSettingsDefaultAgentProviders.includes(candidate)
    ? candidate
    : workspaceSettingsFallbackDefaultAgentProvider;
}

function requireFirstWorkspaceSettingsDefaultAgentProvider(
  providers: readonly DesktopDefaultAgentProvider[]
): DesktopDefaultAgentProvider {
  const provider = providers[0];
  if (!provider) {
    throw new Error("Agent provider registry has no desktop default provider");
  }
  return provider;
}
