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

const defaultDockProviderSet = new Set<AgentGuiWorkbenchProvider>(
  agentGuiWorkbenchDefaultDockProviders
);
const dockSuppressedProviderSet = new Set<AgentGuiWorkbenchProvider>(
  agentGuiWorkbenchDockSuppressedProviders
);
const comingSoonProviderSet = new Set<AgentGuiWorkbenchProvider>(
  agentGuiWorkbenchComingSoonProviders
);
const agentGuiWorkbenchLabelProviders = [
  ...agentGuiWorkbenchProviders,
  "nexight"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

// Import-only source identities are not runnable registry providers, so they
// have no descriptor in the provider identity catalog. They still need a human
// label wherever imported history surfaces (e.g. ChatGPT data-export history).
const agentGuiWorkbenchImportOnlyProviderLabels: Record<string, string> = {
  chatgpt: "ChatGPT"
};

export const agentGuiWorkbenchProviderLabels = {
  ...Object.fromEntries(
    agentGuiWorkbenchLabelProviders.map((provider) => {
      const identity = resolveAgentGUIProviderCatalogIdentity(provider);
      if (!identity) {
        throw new Error(`Missing workbench provider identity for ${provider}`);
      }
      return [provider, identity.displayName];
    })
  ),
  ...agentGuiWorkbenchImportOnlyProviderLabels
} as Record<string, string>;

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
