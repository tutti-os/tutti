import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";

export interface AgentEnvPanelProviderSelection {
  provider: WorkspaceAgentProvider;
  requestSequence: number;
}

export function resolveAgentEnvPanelProviderSelection(input: {
  current: AgentEnvPanelProviderSelection;
  defaultProvider: WorkspaceAgentProvider | null;
  lastSelectedProvider: WorkspaceAgentProvider | null;
  requestedProvider: string | null;
  requestSequence: number;
  visibleProviders: readonly WorkspaceAgentProvider[];
}): AgentEnvPanelProviderSelection | null {
  const isVisible = (
    provider: string | null
  ): provider is WorkspaceAgentProvider =>
    provider !== null &&
    input.visibleProviders.includes(provider as WorkspaceAgentProvider);

  if (
    input.current.requestSequence === input.requestSequence &&
    isVisible(input.current.provider)
  ) {
    return input.current;
  }

  const provider = isVisible(input.requestedProvider)
    ? input.requestedProvider
    : isVisible(input.lastSelectedProvider)
      ? input.lastSelectedProvider
      : isVisible(input.defaultProvider)
        ? input.defaultProvider
        : input.visibleProviders[0];

  return provider ? { provider, requestSequence: input.requestSequence } : null;
}
