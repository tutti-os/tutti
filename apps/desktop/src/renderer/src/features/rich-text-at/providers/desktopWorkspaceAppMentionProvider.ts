import {
  AGENT_GUI_MENTION_PROVIDER_IDS,
  type AgentRichTextAtInsertResult,
  type AgentRichTextAtProvider
} from "@tutti-os/agent-gui/agent-rich-text-at-provider";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";

export interface DesktopWorkspaceAppMentionItem {
  readonly appId: string;
  readonly baseItem: unknown;
  readonly baseInsertResult: AgentRichTextAtInsertResult;
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
  readonly baseProvider: AgentRichTextAtProvider;
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
}: CreateDesktopWorkspaceAppMentionProviderInput): AgentRichTextAtProvider<DesktopWorkspaceAppMentionItem> {
  return {
    id: AGENT_GUI_MENTION_PROVIDER_IDS.workspaceApp,
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
        href: buildWorkspaceAppMentionHref(item),
        kind: "workspace-app",
        label: item.displayName,
        meta: {
          appId: item.appId,
          commandCount: item.commandCount,
          commandDescriptions: item.commandDescriptions,
          commandPaths: item.commandPaths,
          commandSummaries: item.commandSummaries,
          description: item.description,
          iconUrl: item.iconUrl ?? "",
          scopes: item.scopes,
          workspaceId: item.workspaceId
        }
      }
    })
  };
}

function workspaceAppToMentionItem(input: {
  app: WorkspaceAppCenterApp | undefined;
  baseItem: unknown;
  baseProvider: AgentRichTextAtProvider;
  locale: string;
  resolveAppIconUrl?: (appId: string) => string | null;
  workspaceId: string;
}): DesktopWorkspaceAppMentionItem | null {
  const baseInsertResult = input.baseProvider.toInsertResult(input.baseItem);
  if (baseInsertResult.kind !== "mention") {
    return null;
  }
  const appId =
    baseInsertResult.mention.meta?.appId?.trim() ||
    baseInsertResult.mention.entityId.trim();
  if (!appId) {
    return null;
  }
  const baseLabel = normalizeText(
    input.baseProvider.getItemLabel(input.baseItem)
  );
  const baseDescription = normalizeText(
    baseInsertResult.mention.meta?.description
  );
  const baseSubtitle = normalizeText(
    input.baseProvider.getItemSubtitle?.(input.baseItem)
  );
  const localization = input.app
    ? findWorkspaceAppLocalization(input.app, input.locale)
    : null;
  return {
    appId,
    baseItem: input.baseItem,
    baseInsertResult,
    commandCount: baseInsertResult.mention.meta?.commandCount?.trim() ?? "",
    commandDescriptions:
      baseInsertResult.mention.meta?.commandDescriptions?.trim() ?? "",
    commandPaths: baseInsertResult.mention.meta?.commandPaths?.trim() ?? "",
    commandSummaries:
      baseInsertResult.mention.meta?.commandSummaries?.trim() ?? "",
    description:
      normalizeText(localization?.description) ??
      normalizeText(input.app?.description) ??
      baseDescription ??
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
      normalizeText(baseInsertResult.mention.meta?.iconUrl) ??
      null,
    scopes: baseInsertResult.mention.meta?.scopes?.trim() ?? "",
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

function buildWorkspaceAppMentionHref(
  item: DesktopWorkspaceAppMentionItem
): string {
  const params = new URLSearchParams();
  params.set("appId", item.appId);
  params.set("workspaceId", item.workspaceId);
  return `mention://workspace-app?${params.toString()}`;
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
  provider: AgentRichTextAtProvider,
  item: unknown
): string {
  const insertResult = provider.toInsertResult(item);
  if (insertResult.kind !== "mention") {
    return "";
  }
  return (
    insertResult.mention.meta?.appId?.trim() ||
    insertResult.mention.entityId.trim()
  );
}
