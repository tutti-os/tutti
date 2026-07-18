import type { AgentGuiWorkbenchProvider } from "./types.ts";
import { resolveAgentGUIProviderCatalogIdentity } from "../providerIdentityCatalog.ts";

export const agentGuiWorkbenchProviders = [
  "claude-code",
  "codex",
  "cursor",
  "tutti-agent",
  "opencode",
  "hermes",
  "openclaw"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

export const agentGuiWorkbenchDefaultDockProviders = [
  "codex",
  "claude-code",
  "tutti-agent"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

export const agentGuiWorkbenchDockSuppressedProviders = [
  "hermes",
  "opencode"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

export const agentGuiWorkbenchComingSoonProviders =
  [] as const satisfies readonly AgentGuiWorkbenchProvider[];

// Preview/Beta/being-onboarded agents. These are gated behind the "Preview
// Agents" Labs switch: selection surfaces (dock, launchpad, app center, the
// Agents settings tab) only show them when the switch is on. Stable providers
// are never in this list, so they always show regardless of the switch. This
// is the single authoritative list; call sites consume the predicate rather
// than branching on provider names.
export const agentGuiWorkbenchPreviewProviders = [
  "hermes"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

const defaultDockProviderSet = new Set<AgentGuiWorkbenchProvider>(
  agentGuiWorkbenchDefaultDockProviders
);
const dockSuppressedProviderSet = new Set<AgentGuiWorkbenchProvider>(
  agentGuiWorkbenchDockSuppressedProviders
);
const comingSoonProviderSet = new Set<AgentGuiWorkbenchProvider>(
  agentGuiWorkbenchComingSoonProviders
);
const previewProviderSet = new Set<AgentGuiWorkbenchProvider>(
  agentGuiWorkbenchPreviewProviders
);
const agentGuiWorkbenchLabelProviders = [
  ...agentGuiWorkbenchProviders,
  "nexight"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

export const agentGuiWorkbenchProviderLabels = Object.fromEntries(
  agentGuiWorkbenchLabelProviders.map((provider) => {
    const identity = resolveAgentGUIProviderCatalogIdentity(provider);
    if (!identity) {
      throw new Error(`Missing workbench provider identity for ${provider}`);
    }
    return [provider, identity.displayName];
  })
) as Record<string, string>;

export function resolveAgentGuiWorkbenchProviderLabel(
  provider: AgentGuiWorkbenchProvider
): string {
  return agentGuiWorkbenchProviderLabels[provider] ?? provider;
}

export function isAgentGuiWorkbenchDefaultDockProvider(
  provider: AgentGuiWorkbenchProvider
): boolean {
  return defaultDockProviderSet.has(provider);
}

export function isAgentGuiWorkbenchDockSuppressedProvider(
  provider: AgentGuiWorkbenchProvider
): boolean {
  return dockSuppressedProviderSet.has(provider);
}

export function isAgentGuiWorkbenchComingSoonProvider(
  provider: AgentGuiWorkbenchProvider
): boolean {
  return comingSoonProviderSet.has(provider);
}

export function isAgentGuiWorkbenchPreviewProvider(
  provider: AgentGuiWorkbenchProvider
): boolean {
  return previewProviderSet.has(provider);
}

// Whether a provider should be shown given the current Preview-Agents switch.
// Stable providers always show; preview providers show only when enabled.
export function isAgentGuiWorkbenchProviderVisibleWithPreview(
  provider: AgentGuiWorkbenchProvider,
  previewAgentsEnabled: boolean
): boolean {
  return previewAgentsEnabled || !previewProviderSet.has(provider);
}

export function isAgentGuiWorkbenchProvider(
  value: unknown
): value is AgentGuiWorkbenchProvider {
  return (
    typeof value === "string" && /^[a-z][a-z0-9._:-]{0,127}$/.test(value.trim())
  );
}

export function normalizeAgentGuiWorkbenchProvider(
  value: unknown
): AgentGuiWorkbenchProvider {
  if (!isAgentGuiWorkbenchProvider(value)) {
    throw new Error("agent_gui_workbench.invalid_provider");
  }
  return value.trim();
}
