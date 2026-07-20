import type { AgentGuiWorkbenchProvider } from "./types.ts";
import { resolveAgentGUIProviderCatalogIdentity } from "../providerIdentityCatalog.ts";

export const agentGuiWorkbenchProviders = [
  "claude-code",
  "codex",
  "cursor",
  "tutti-agent",
  "opencode",
  "hermes",
  "openclaw",
  "kimi-code"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

export const agentGuiWorkbenchDefaultDockProviders = [
  "codex",
  "claude-code",
  "tutti-agent"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

export const agentGuiWorkbenchDockSuppressedProviders = [
  "hermes",
  "opencode",
  "kimi-code"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

export const agentGuiWorkbenchComingSoonProviders =
  [] as const satisfies readonly AgentGuiWorkbenchProvider[];

// Agent integrations still being validated in Tutti. These are gated behind
// the Early Access integrations switch: selection surfaces (dock, launchpad,
// app center, and Agents settings) only show them when the switch is on. This
// describes Tutti's integration maturity, not the upstream Agent's maturity.
// Call sites consume the predicate rather than branching on provider names.
export const agentGuiWorkbenchEarlyAccessProviders = [
  "hermes",
  "openclaw"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

/** @deprecated Use agentGuiWorkbenchEarlyAccessProviders. */
export const agentGuiWorkbenchPreviewProviders =
  agentGuiWorkbenchEarlyAccessProviders;

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
  agentGuiWorkbenchEarlyAccessProviders
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

export function isAgentGuiWorkbenchEarlyAccessProvider(
  provider: AgentGuiWorkbenchProvider
): boolean {
  return previewProviderSet.has(provider);
}

/** @deprecated Use isAgentGuiWorkbenchEarlyAccessProvider. */
export const isAgentGuiWorkbenchPreviewProvider =
  isAgentGuiWorkbenchEarlyAccessProvider;

// Whether a provider should be shown given the Early Access integrations
// switch. Stable integrations always show; early-access integrations show only
// when enabled.
export function isAgentGuiWorkbenchProviderVisibleWithEarlyAccess(
  provider: AgentGuiWorkbenchProvider,
  earlyAccessEnabled: boolean
): boolean {
  return earlyAccessEnabled || !previewProviderSet.has(provider);
}

/** @deprecated Use isAgentGuiWorkbenchProviderVisibleWithEarlyAccess. */
export const isAgentGuiWorkbenchProviderVisibleWithPreview =
  isAgentGuiWorkbenchProviderVisibleWithEarlyAccess;

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
