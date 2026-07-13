import { generatedProviderIdentityCatalog } from "./generated/providerIdentityCatalog.ts";
import type { TranslateFn } from "./i18n/index.ts";

export interface AgentGUIProviderIdentityCatalogEntry {
  providerId: string;
  displayName: string;
  iconKey: string;
  localeKey: string;
  aliases: readonly string[];
  target: {
    id: string;
    launchRefType: string;
    enabled: boolean;
    sortOrder: number;
  };
  desktop: {
    managed: boolean;
    managedOrder: number;
    statusProbePriority: number;
    usageProbeKind: string;
    visibilityGate: string;
    runtimeProbeFallback: "" | "direct";
    installBootstrap: boolean;
    refreshOnAccountChange: boolean;
    unavailableDockOrderOffset: number;
    developerLogs: boolean;
    defaultProviderEligible: boolean;
    defaultProviderPriority: number;
  };
  source: "generated";
}

export const migratedAgentGUIProviderIdentityCatalog: readonly AgentGUIProviderIdentityCatalogEntry[] =
  generatedProviderIdentityCatalog.map((entry) => ({
    ...entry,
    source: "generated" as const
  }));

const migratedIdentityByKey = indexIdentities(
  migratedAgentGUIProviderIdentityCatalog
);

export function resolveMigratedAgentGUIProviderIdentity(
  value: string | null | undefined
): AgentGUIProviderIdentityCatalogEntry | null {
  return migratedIdentityByKey.get(normalizeIdentityKey(value)) ?? null;
}

export function resolveAgentGUIProviderCatalogIdentity(
  value: string | null | undefined
): AgentGUIProviderIdentityCatalogEntry | null {
  return resolveMigratedAgentGUIProviderIdentity(value);
}

export function agentGUIProviderIdentityDisplayName(
  identity: AgentGUIProviderIdentityCatalogEntry,
  t: TranslateFn
): string {
  const localeKey = identity.localeKey;
  const localized = t(localeKey);
  return localized === localeKey ? identity.displayName : localized;
}

function indexIdentities(
  entries: readonly AgentGUIProviderIdentityCatalogEntry[]
): ReadonlyMap<string, AgentGUIProviderIdentityCatalogEntry> {
  const result = new Map<string, AgentGUIProviderIdentityCatalogEntry>();
  for (const entry of entries) {
    for (const key of [entry.providerId, ...entry.aliases]) {
      result.set(normalizeIdentityKey(key), entry);
    }
  }
  return result;
}

function normalizeIdentityKey(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
