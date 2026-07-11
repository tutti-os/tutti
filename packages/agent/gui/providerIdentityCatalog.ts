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
  targetDisplayName?: string;
  source: "generated" | "legacy";
}

export const migratedAgentGUIProviderIdentityCatalog: readonly AgentGUIProviderIdentityCatalogEntry[] =
  generatedProviderIdentityCatalog.map((entry) => ({
    ...entry,
    source: "generated" as const
  }));

/**
 * Explicit compatibility catalog for providers that have not migrated to
 * providerregistry.Migrated(). Delete entries as their descriptors land.
 */
const legacyAgentGUIProviderIdentityFallbacks: readonly AgentGUIProviderIdentityCatalogEntry[] =
  [
    legacyIdentity("cursor", "Cursor", "cursor", [
      "cursor-agent",
      "cursor agent"
    ]),
    legacyIdentity("tutti-agent", "Tutti Agent", "tutti", ["tutti agent"]),
    legacyIdentity("nexight", "Nexight", "tutti", ["tutti"], "Tutti Agent"),
    legacyIdentity("opencode", "OpenCode", "opencode", [
      "open-code",
      "opencode-ai"
    ]),
    legacyIdentity("hermes", "Hermes Agent", "hermes", [], "Hermes"),
    legacyIdentity("openclaw", "OpenClaw", "openclaw", [])
  ];

const migratedIdentityByKey = indexIdentities(
  migratedAgentGUIProviderIdentityCatalog
);
const legacyIdentityByKey = indexIdentities(
  legacyAgentGUIProviderIdentityFallbacks
);

export function resolveMigratedAgentGUIProviderIdentity(
  value: string | null | undefined
): AgentGUIProviderIdentityCatalogEntry | null {
  return migratedIdentityByKey.get(normalizeIdentityKey(value)) ?? null;
}

export function resolveAgentGUIProviderCatalogIdentity(
  value: string | null | undefined
): AgentGUIProviderIdentityCatalogEntry | null {
  const key = normalizeIdentityKey(value);
  return migratedIdentityByKey.get(key) ?? legacyIdentityByKey.get(key) ?? null;
}

export function agentGUIProviderIdentityDisplayName(
  identity: AgentGUIProviderIdentityCatalogEntry,
  t: TranslateFn
): string {
  const localeKey = identity.localeKey;
  const localized = t(localeKey);
  return localized === localeKey ? identity.displayName : localized;
}

function legacyIdentity(
  providerId: string,
  displayName: string,
  iconKey: string,
  aliases: readonly string[],
  targetDisplayName?: string
): AgentGUIProviderIdentityCatalogEntry {
  return {
    providerId,
    displayName,
    iconKey,
    localeKey: providerId,
    aliases,
    target: {
      id: `local:${providerId}`,
      launchRefType: "local_cli",
      enabled: true,
      sortOrder: 1_000
    },
    ...(targetDisplayName ? { targetDisplayName } : {}),
    source: "legacy"
  };
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
