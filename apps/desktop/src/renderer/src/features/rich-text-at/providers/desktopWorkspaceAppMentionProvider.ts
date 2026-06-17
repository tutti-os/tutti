import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionInsertResult,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";

export interface DesktopWorkspaceAppMentionItem {
  readonly appId: string;
  readonly baseItem: unknown;
  readonly baseInsertResult: AgentContextMentionInsertResult;
  readonly commandCount: string;
  readonly commandDescriptions: string;
  readonly commandPaths: string;
  readonly commandSummaries: string;
  readonly description: string;
  readonly displayName: string;
  readonly iconUrl: string | null;
  readonly scopes: string;
  readonly workspaceId: string;
}

export interface CreateDesktopWorkspaceAppMentionProviderInput {
  readonly apps: readonly WorkspaceAppCenterApp[];
  readonly baseProvider: AgentContextMentionProvider;
  readonly locale: string;
  readonly resolveAppIconUrl?: (appId: string) => string | null;
  readonly workspaceId: string;
}

export function createDesktopWorkspaceAppMentionProvider({
  apps,
  baseProvider,
  locale,
  resolveAppIconUrl,
  workspaceId
}: CreateDesktopWorkspaceAppMentionProviderInput): AgentContextMentionProvider<DesktopWorkspaceAppMentionItem> {
  return {
    id: AGENT_CONTEXT_MENTION_PROVIDER_IDS.workspaceApp,
    trigger: "@",
    getItemKey: (item) => item.appId,
    getItemLabel: (item) => item.displayName,
    getItemSubtitle: (item) => item.description,
    getItemThumbnailUrl: (item) => item.iconUrl,
    async query(input) {
      const normalizedKeyword = normalizeSearchText(input.keyword);
      const baseItems = await Promise.resolve(
        baseProvider.query({
          ...input,
          keyword: "",
          maxResults: undefined
        })
      );
      const appMetadataById = new Map(
        apps.map((app) => [app.appId, app] as const)
      );
      return baseItems
        .map((item) =>
          workspaceAppToMentionItem({
            app: appMetadataById.get(
              workspaceAppIdFromProviderItem(baseProvider, item)
            ),
            baseItem: item,
            baseProvider,
            locale,
            resolveAppIconUrl,
            workspaceId
          })
        )
        .filter((item): item is DesktopWorkspaceAppMentionItem => item !== null)
        .filter((item) =>
          matchesWorkspaceAppMentionKeyword(item, normalizedKeyword)
        )
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName, locale)
        );
    },
    toInsertResult: (item) => ({
      kind: "mention",
      mention: {
        entityId: item.appId,
        label: item.displayName,
        scope: compactStringRecord({
          workspaceId: item.workspaceId
        }),
        presentation: compactMentionPresentation({
          description: item.description,
          iconUrl: item.iconUrl ?? "",
          subtitle: item.description
        })
      }
    })
  };
}

function workspaceAppToMentionItem(input: {
  app: WorkspaceAppCenterApp | undefined;
  baseItem: unknown;
  baseProvider: AgentContextMentionProvider;
  locale: string;
  resolveAppIconUrl?: (appId: string) => string | null;
  workspaceId: string;
}): DesktopWorkspaceAppMentionItem | null {
  const baseInsertResult = input.baseProvider.toInsertResult(input.baseItem);
  if (baseInsertResult.kind !== "mention") {
    return null;
  }
  const appId = baseInsertResult.mention.entityId.trim();
  if (!appId) {
    return null;
  }
  const baseLabel = normalizeText(
    input.baseProvider.getItemLabel(input.baseItem)
  );
  const baseDescription = normalizeText(
    baseInsertResult.mention.presentation?.description
  );
  const basePresentationSubtitle = normalizeText(
    baseInsertResult.mention.presentation?.subtitle
  );
  const baseSubtitle = normalizeText(
    input.baseProvider.getItemSubtitle?.(input.baseItem)
  );
  const baseObject = objectRecord(input.baseItem);
  const localization = input.app
    ? findWorkspaceAppLocalization(input.app, input.locale)
    : null;
  return {
    appId,
    baseItem: input.baseItem,
    baseInsertResult,
    commandCount: readBaseItemString(baseObject, "commandCount"),
    commandDescriptions: readBaseItemStringList(
      baseObject,
      "commandDescriptions"
    ),
    commandPaths: readBaseItemStringList(baseObject, "commandPaths"),
    commandSummaries: readBaseItemStringList(baseObject, "commandSummaries"),
    description:
      normalizeText(localization?.description) ??
      normalizeText(input.app?.description) ??
      baseDescription ??
      basePresentationSubtitle ??
      baseSubtitle ??
      "",
    displayName:
      normalizeText(localization?.name) ??
      normalizeText(input.app?.name) ??
      baseLabel ??
      appId,
    iconUrl:
      normalizeText(input.resolveAppIconUrl?.(appId)) ??
      normalizeText(input.app?.iconUrl) ??
      normalizeText(input.app?.availableIconUrl) ??
      normalizeText(baseInsertResult.mention.presentation?.iconUrl) ??
      null,
    scopes: readBaseItemStringList(baseObject, "scopes"),
    workspaceId: input.workspaceId
  };
}

function findWorkspaceAppLocalization(
  app: WorkspaceAppCenterApp,
  locale: string
): NonNullable<WorkspaceAppCenterApp["localizations"]>[number] | null {
  const localizations = app.localizations ?? [];
  const normalizedLocale = normalizeLocale(locale);
  if (!normalizedLocale || localizations.length === 0) {
    return null;
  }

  const exact = localizations.find(
    (localization) => normalizeLocale(localization.locale) === normalizedLocale
  );
  if (exact) {
    return exact;
  }

  const language = normalizedLocale.split("-")[0];
  return (
    localizations.find(
      (localization) =>
        normalizeLocale(localization.locale)?.split("-")[0] === language
    ) ?? null
  );
}

function matchesWorkspaceAppMentionKeyword(
  item: DesktopWorkspaceAppMentionItem,
  normalizedKeyword: string
): boolean {
  if (!normalizedKeyword) {
    return true;
  }
  return [
    item.appId,
    item.displayName,
    item.description,
    item.commandPaths,
    item.commandSummaries,
    item.commandDescriptions,
    item.scopes
  ].some((value) => normalizeSearchText(value).includes(normalizedKeyword));
}

function normalizeLocale(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/_/gu, "-").toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function workspaceAppIdFromProviderItem(
  provider: AgentContextMentionProvider,
  item: unknown
): string {
  const insertResult = provider.toInsertResult(item);
  if (insertResult.kind !== "mention") {
    return "";
  }
  return insertResult.mention.entityId.trim();
}

function compactStringRecord(
  record: Readonly<Record<string, string | null | undefined>>
): Readonly<Record<string, string>> | undefined {
  const entries = Object.entries(record)
    .map(([key, value]) => [key.trim(), value?.trim() ?? ""] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactMentionPresentation(presentation: {
  description?: string;
  iconUrl?: string;
  subtitle?: string;
}):
  | NonNullable<
      Extract<
        AgentContextMentionInsertResult,
        { kind: "mention" }
      >["mention"]["presentation"]
    >
  | undefined {
  const entries = Object.entries(presentation)
    .map(([key, value]) => [key.trim(), value?.trim() ?? ""] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readBaseItemString(
  item: Readonly<Record<string, unknown>>,
  key: string
): string {
  const value = item[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" ? value.trim() : "";
}

function readBaseItemStringList(
  item: Readonly<Record<string, unknown>>,
  key: string
): string {
  const value = item[key];
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .join("\n");
  }
  return typeof value === "string" ? value.trim() : "";
}
