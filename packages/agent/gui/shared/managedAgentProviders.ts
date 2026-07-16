import { resolveAgentGUIProviderCatalogIdentity } from "../providerIdentityCatalog.ts";

export function normalizeManagedAgentProvider(
  provider: string | undefined
): string {
  const normalized =
    provider
      ?.trim()
      .toLowerCase()
      .replace(/[_\s]+/gu, "-") ?? "";
  return (
    resolveAgentGUIProviderCatalogIdentity(normalized)?.iconKey ??
    (normalized === "tutti-doc" ? "tutti" : normalized)
  );
}

/** Providers still shipping in preview; the hero surfaces a "Beta" tag for them. */
const BETA_AGENT_PROVIDERS: ReadonlySet<string> = new Set([
  "opencode",
  "cursor"
]);

export function isBetaAgentProvider(
  provider: string | null | undefined
): boolean {
  if (!provider) {
    return false;
  }
  return BETA_AGENT_PROVIDERS.has(normalizeManagedAgentProvider(provider));
}
