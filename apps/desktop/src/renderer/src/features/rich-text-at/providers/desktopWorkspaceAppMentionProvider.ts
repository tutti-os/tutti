import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionInsertResult,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import { appCenterI18nResources } from "@tutti-os/workspace-app-center/i18n";

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

interface BuiltInWorkspaceAppMetadata {
  readonly description: string;
  readonly name: string;
}

interface BuiltInWorkspaceAppResource {
  readonly appCenter: {
    readonly catalogApps: {
      readonly issueManager: BuiltInWorkspaceAppMetadata;
    };
  };
}

export interface CreateDesktopWorkspaceAppMentionProviderInput {
  readonly apps: readonly WorkspaceAppCenterApp[];
  readonly baseProvider: AgentContextMentionProvider;
  readonly locale: string;
  readonly workspaceId: string;
}

export function createDesktopWorkspaceAppMentionProvider({
  apps,
  baseProvider,
  locale,
  workspaceId
}: CreateDesktopWorkspaceAppMentionProviderInput): AgentContextMentionProvider<DesktopWorkspaceAppMentionItem> {
  return {
    id: AGENT_CONTEXT_MENTION_PROVIDER_IDS.workspaceApp,
    trigger: "@",
    getItemKey: (item) => item.appId,
    getItemLabel: (item) => item.displayName,
    getItemSubtitle: (item) => item.description,
    getItemIconUrl: (item) => item.iconUrl,
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
      const coveredAppIds = new Set(
        baseItems
          .map((item) => workspaceAppIdFromProviderItem(baseProvider, item))
          .filter((appId) => appId.length > 0)
      );
      const fromBase = baseItems
        .map((item) =>
          workspaceAppToMentionItem({
            app: appMetadataById.get(
              workspaceAppIdFromProviderItem(baseProvider, item)
            ),
            baseItem: item,
            baseProvider,
            locale,
            workspaceId
          })
        )
        .filter((item): item is DesktopWorkspaceAppMentionItem => item !== null)
        .filter((item) =>
          matchesWorkspaceAppMentionKeyword(item, normalizedKeyword)
        );
      const fromAppCenter = apps
        .filter(
          (app) => app.installed && app.enabled && !coveredAppIds.has(app.appId)
        )
        .map((app) =>
          workspaceAppCenterAppToMentionItem(app, locale, workspaceId)
        )
        .filter((item) =>
          matchesWorkspaceAppMentionKeyword(item, normalizedKeyword)
        );
      return [...fromBase, ...fromAppCenter].sort((left, right) =>
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

function workspaceAppCenterAppToMentionItem(
  app: WorkspaceAppCenterApp,
  locale: string,
  workspaceId: string
): DesktopWorkspaceAppMentionItem {
  const localization = findWorkspaceAppLocalization(app, locale);
  const displayName =
    normalizeText(localization?.name) ?? normalizeText(app.name) ?? app.appId;
  const description =
    normalizeText(localization?.description) ??
    normalizeText(app.description) ??
    "";
  const iconUrl =
    normalizeText(app.iconUrl) ?? normalizeText(app.availableIconUrl) ?? null;
  const baseInsertResult: AgentContextMentionInsertResult = {
    kind: "mention",
    mention: {
      entityId: app.appId,
      label: displayName,
      scope: compactStringRecord({
        workspaceId
      }),
      presentation: compactMentionPresentation({
        description,
        iconUrl: iconUrl ?? "",
        subtitle: description
      })
    }
  };
  return {
    appId: app.appId,
    baseItem: app,
    baseInsertResult,
    commandCount: "",
    commandDescriptions: "",
    commandPaths: "",
    commandSummaries: "",
    description,
    displayName,
    iconUrl,
    scopes: "",
    workspaceId
  };
}

function workspaceAppToMentionItem(input: {
  app: WorkspaceAppCenterApp | undefined;
  baseItem: unknown;
  baseProvider: AgentContextMentionProvider;
  locale: string;
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
  const builtInMetadata = findBuiltInWorkspaceAppMetadata(appId, input.locale);
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
      normalizeText(builtInMetadata?.description) ??
      baseDescription ??
      basePresentationSubtitle ??
      baseSubtitle ??
      "",
    displayName:
      normalizeText(localization?.name) ??
      normalizeText(input.app?.name) ??
      normalizeText(builtInMetadata?.name) ??
      baseLabel ??
      appId,
    iconUrl:
      normalizeText(input.app?.iconUrl) ??
      normalizeText(input.app?.availableIconUrl) ??
      normalizeText(baseInsertResult.mention.presentation?.iconUrl) ??
      null,
    scopes: readBaseItemStringList(baseObject, "scopes"),
    workspaceId: input.workspaceId
  };
}

function findBuiltInWorkspaceAppMetadata(
  appId: string,
  locale: string
): BuiltInWorkspaceAppMetadata | null {
  if (appId !== "issue-manager") {
    return null;
  }
  const normalizedLocale = normalizeLocale(locale);
  if (normalizedLocale?.split("-")[0] === "zh") {
    return builtInWorkspaceAppMetadataFromResource(
      appCenterI18nResources["zh-CN"]
    );
  }
  return builtInWorkspaceAppMetadataFromResource(appCenterI18nResources.en);
}

function builtInWorkspaceAppMetadataFromResource(
  resource: unknown
): BuiltInWorkspaceAppMetadata {
  return (resource as BuiltInWorkspaceAppResource).appCenter.catalogApps
    .issueManager;
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
