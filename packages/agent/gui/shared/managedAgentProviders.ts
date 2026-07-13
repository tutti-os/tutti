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
