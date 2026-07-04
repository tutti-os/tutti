import type {
  AgentProviderStatus,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import { normalizeAgentTitleText } from "@tutti-os/agent-gui/agent-title-text";
import { appCenterI18nResources } from "@tutti-os/workspace-app-center/i18n";
import {
  createRichTextMarkdownLinkInsertResult,
  createRichTextTriggerProvider,
  createRichTextMentionInsertResult
} from "@tutti-os/ui-rich-text/plugins";
import type {
  RichTextMentionInsert,
  RichTextMentionPresentation,
  RichTextMentionResolved,
  RichTextTriggerProvider
} from "@tutti-os/ui-rich-text/types";
import {
  tuttiFileAssetUrls,
  tuttiFolderAssetUrls,
  tuttiIssueAssetUrls
} from "../../../../../../shared/tuttiAssetProtocol.ts";
import type {
  AgentTargetPresentation,
  IAgentsService
} from "../../../workspace-agent/services/agentsService.interface";
import { resolveDesktopWorkspaceAppDefaultIconUrl } from "../../../../../../shared/workspaceAppIconDefaults.ts";
import type {
  DesktopRichTextAtCapability,
  DesktopRichTextTriggerProviderRequest,
  IDesktopRichTextAtService
} from "../richTextAtService.interface";
import { compareDesktopWorkspaceAppMentionItems } from "../../providers/desktopWorkspaceAppMentionOrdering.ts";
import {
  createDesktopAgentSessionMentionProvider,
  type DesktopAgentSessionStatusView
} from "../../providers/desktopAgentSessionMentionProvider.ts";

interface DesktopRichTextAtContributor {
  capability: DesktopRichTextAtCapability;
  getProviders: (
    input: DesktopRichTextTriggerProviderRequest
  ) => readonly RichTextTriggerProvider<unknown>[];
}

export interface DesktopRichTextAtServiceDependencies {
  agentsService?: Pick<IAgentsService, "load">;
  tuttidClient: TuttidClient;
  /** Active UI locale getter, read at query time so locale switches are picked up. */
  getLocale?: () => string;
  /** Resolve the rounded managed-agent icon URL for a session's provider. */
  resolveAgentIconUrl?: (provider: string) => string;
  /** The bundled user-avatar placeholder asset URL. */
  userAvatarPlaceholderUrl?: string;
  /** Resolve a session's raw status into the display-ready activity status view. */
  resolveSessionStatusView?: (
    status: string
  ) => DesktopAgentSessionStatusView | null;
  /** Live getter for agent availability, used to hide unbound agent apps. */
  agentProviderStatuses?: () => readonly AgentProviderStatus[] | undefined;
}

interface WorkspaceFileAtItem {
  displayName?: string | null;
  kind?: "directory" | "file" | (string & {});
  name?: string | null;
  path: string;
}

interface WorkspaceIssueAtItem {
  content?: string | null;
  creatorDisplayName?: string | null;
  issueId: string;
  status?: string | null;
  title: string;
  topicId: string;
  workspaceId: string;
}

interface AgentSessionAtItem {
  agentName?: string | null;
  createdAtUnixMs?: number | null;
  id: string;
  initiatorName?: string | null;
  provider?: string | null;
  scope?: "my_sessions" | "collab_sessions";
  sessionOrigin?: string | null;
  status?: string | null;
  title?: string | null;
  updatedAtUnixMs?: number | null;
  userId?: string | null;
  workspaceId: string;
}

interface AgentTargetAtItem {
  description: string;
  displayName: string;
  iconUrl: string;
  provider: WorkspaceAgentProvider;
  targetId: string;
  workspaceId: string;
}

interface WorkspaceAppAtItem {
  appId: string;
  commandCount: number;
  commandDescriptions: string[];
  commandPaths: string[];
  description: string;
  commandSummaries: string[];
  displayName: string;
  iconUrl: string | null;
  referencesListSupported: boolean;
  scopes: string[];
  workspaceId: string;
}

interface BuiltInWorkspaceAppMetadata {
  readonly description: string;
  readonly name: string;
}

interface BuiltInWorkspaceAppResource {
  readonly appCenter: {
    readonly catalogApps: {
      readonly agentClaudeCode: BuiltInWorkspaceAppMetadata;
      readonly agentCodex: BuiltInWorkspaceAppMetadata;
      readonly issueManager: BuiltInWorkspaceAppMetadata;
    };
  };
}

const {
  agentTarget: AGENT_TARGET_PROVIDER_ID,
  agentSession: AGENT_SESSION_PROVIDER_ID,
  file: FILE_PROVIDER_ID,
  workspaceApp: WORKSPACE_APP_PROVIDER_ID,
  workspaceIssue: WORKSPACE_ISSUE_PROVIDER_ID
} = AGENT_CONTEXT_MENTION_PROVIDER_IDS;

const RICH_TEXT_MENTION_PRESENTATION_KEYS = [
  "agentProviderId",
  "agentIconUrl",
  "iconUrl",
  "thumbnailUrl",
  "subtitle",
  "description",
  "participant",
  "status",
  "statusDataStatus",
  "statusLabel",
  "statusPulse",
  "userAvatarPlaceholderUrl",
  "referencesListSupported"
] as const satisfies readonly (keyof RichTextMentionPresentation)[];

export class DesktopRichTextAtService implements IDesktopRichTextAtService {
  readonly _serviceBrand = undefined;
  private readonly contributors: readonly DesktopRichTextAtContributor[];
  private readonly dependencies: DesktopRichTextAtServiceDependencies;
  private readonly providerCache = new Map<
    string,
    readonly RichTextTriggerProvider[]
  >();

  constructor(dependencies: DesktopRichTextAtServiceDependencies) {
    this.dependencies = dependencies;
    this.contributors = [
      createWorkspaceFileAtContributor(dependencies.tuttidClient),
      createWorkspaceIssueAtContributor(dependencies.tuttidClient),
      createAgentTargetAtContributor({
        agentsService: dependencies.agentsService,
        agentProviderStatuses: dependencies.agentProviderStatuses
      }),
      createAgentSessionAtContributor(dependencies.tuttidClient),
      createWorkspaceAppAtContributor({
        tuttidClient: dependencies.tuttidClient,
        getLocale: dependencies.getLocale
      })
    ];
  }

  getProviders(
    input: DesktopRichTextTriggerProviderRequest
  ): readonly RichTextTriggerProvider[] {
    const requestedCapabilities = new Set(input.capabilities);
    if (requestedCapabilities.size === 0) {
      return [];
    }

    const cacheKey =
      input.metadata === undefined
        ? createProviderCacheKey(input, requestedCapabilities)
        : null;
    if (cacheKey !== null) {
      const cachedProviders = this.providerCache.get(cacheKey);
      if (cachedProviders) {
        return this.enrichProviders(cachedProviders);
      }
    }

    const providers = this.contributors.flatMap((contributor) =>
      requestedCapabilities.has(contributor.capability)
        ? contributor.getProviders(input)
        : []
    );
    if (cacheKey !== null) {
      this.providerCache.set(cacheKey, providers);
    }
    return this.enrichProviders(providers);
  }

  private enrichProviders(
    providers: readonly RichTextTriggerProvider[]
  ): readonly RichTextTriggerProvider[] {
    const deps = this.dependencies;
    const resolveAgentIconUrl = deps.resolveAgentIconUrl;
    const userAvatarPlaceholderUrl = deps.userAvatarPlaceholderUrl;
    const resolveSessionStatusView = deps.resolveSessionStatusView;
    const canEnrichSession =
      resolveAgentIconUrl !== undefined &&
      userAvatarPlaceholderUrl !== undefined &&
      resolveSessionStatusView !== undefined;
    if (!canEnrichSession) {
      return providers;
    }
    return providers.map((provider): RichTextTriggerProvider => {
      if (canEnrichSession && provider.id === AGENT_SESSION_PROVIDER_ID) {
        return createDesktopAgentSessionMentionProvider({
          baseProvider: provider as unknown as AgentContextMentionProvider,
          resolveAgentIconUrl,
          userAvatarPlaceholderUrl,
          resolveStatusView: resolveSessionStatusView
        });
      }
      return provider;
    });
  }
}

function createWorkspaceAppAtContributor(contributorInput: {
  tuttidClient: TuttidClient;
  getLocale?: () => string;
}): DesktopRichTextAtContributor {
  return {
    capability: "workspace-app",
    getProviders(input) {
      return [
        createRichTextTriggerProvider<WorkspaceAppAtItem>({
          id: WORKSPACE_APP_PROVIDER_ID,
          trigger: "@",
          async query(searchInput) {
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            const response =
              await contributorInput.tuttidClient.listWorkspaceAppMentionCandidates(
                input.workspaceId
              );
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            return workspaceAppAtItemsFromMentionCandidates({
              candidates: response.apps,
              excludedAppIds: excludedWorkspaceAppMentionIds(input.target),
              keyword: searchInput.keyword,
              locale: contributorInput.getLocale?.() ?? "",
              maxResults: searchInput.maxResults,
              workspaceId: input.workspaceId
            });
          },
          getItemKey: (item) => item.appId,
          getItemLabel: (item) => item.displayName,
          getItemSubtitle: (item) => item.description,
          getItemIconUrl: (item) => item.iconUrl,
          toInsertResult(item) {
            return createDesktopRichTextMentionInsertResult({
              entityId: item.appId,
              label: item.displayName,
              scope: compactStringRecord({
                workspaceId: item.workspaceId
              }),
              presentation: compactMentionPresentation({
                description: item.description,
                iconUrl: item.iconUrl ?? "",
                referencesListSupported: item.referencesListSupported
                  ? "true"
                  : "",
                subtitle: item.description
              })
            });
          },
          async resolveMention(identity) {
            const workspaceId = scopeString(identity.scope, "workspaceId");
            if (!workspaceId) {
              return null;
            }
            return resolveMentionSafely(async () => {
              const response =
                await contributorInput.tuttidClient.listWorkspaceAppMentionCandidates(
                  workspaceId
                );
              const item = workspaceAppAtItemsFromMentionCandidates({
                candidates: response.apps,
                excludedAppIds: excludedWorkspaceAppMentionIds(input.target),
                keyword: "",
                locale: contributorInput.getLocale?.() ?? "",
                workspaceId
              }).find((app) => app.appId === identity.entityId);
              if (!item) {
                return null;
              }
              return {
                label: item.displayName,
                presentation: compactMentionPresentation({
                  description: item.description,
                  iconUrl: item.iconUrl ?? "",
                  referencesListSupported: item.referencesListSupported
                    ? "true"
                    : "",
                  subtitle: item.description
                })
              };
            });
          }
        })
      ];
    }
  };
}

function workspaceAppAtItemsFromMentionCandidates(input: {
  candidates: Awaited<
    ReturnType<TuttidClient["listWorkspaceAppMentionCandidates"]>
  >["apps"];
  excludedAppIds?: readonly string[];
  keyword: string;
  locale: string;
  maxResults?: number;
  workspaceId: string;
}): WorkspaceAppAtItem[] {
  const apps: WorkspaceAppAtItem[] = [];
  const excludedAppIds = new Set(
    (input.excludedAppIds ?? []).map((appId) => appId.trim().toLowerCase())
  );
  for (const candidate of input.candidates) {
    const appId = candidate.appId.trim();
    if (!appId) {
      continue;
    }
    if (excludedAppIds.has(appId.toLowerCase())) {
      continue;
    }
    if (isLegacyAgentWorkspaceAppMentionId(appId)) {
      continue;
    }
    const localization = findWorkspaceAppMentionLocalization(
      candidate,
      input.locale
    );
    const builtInMetadata = findBuiltInWorkspaceAppMetadata(
      appId,
      input.locale
    );
    const candidateDescription = normalizeText(candidate.description) ?? "";
    const candidateDisplayName = normalizeText(candidate.displayName) ?? appId;
    const builtInDescription =
      candidate.source === "cli_app"
        ? normalizeText(builtInMetadata?.description)
        : null;
    const builtInDisplayName =
      candidate.source === "cli_app"
        ? normalizeText(builtInMetadata?.name)
        : null;
    apps.push({
      appId,
      commandCount: candidate.cli.commandCount,
      commandDescriptions: candidate.cli.commandDescriptions,
      commandPaths: candidate.cli.commandPaths,
      description:
        normalizeText(localization?.description) ??
        builtInDescription ??
        candidateDescription,
      commandSummaries: candidate.cli.commandSummaries,
      displayName:
        normalizeText(localization?.displayName) ??
        builtInDisplayName ??
        candidateDisplayName,
      iconUrl: workspaceAppIconUrl(candidate, appId),
      referencesListSupported: candidate.references.listSupported,
      scopes: candidate.cli.scopes,
      workspaceId: input.workspaceId
    });
  }

  const keyword = input.keyword.trim().toLowerCase();
  const matchedApps = apps
    .filter((app) => workspaceAppMatchesKeyword(app, keyword))
    .sort((left, right) =>
      compareDesktopWorkspaceAppMentionItems(left, right, input.locale)
    );
  return input.maxResults === undefined
    ? matchedApps
    : matchedApps.slice(0, Math.max(0, input.maxResults));
}

function excludedWorkspaceAppMentionIds(target: string): readonly string[] {
  return target === "issue-manager" ? ["issue-manager"] : [];
}

const WORKSPACE_AGENT_APP_PROVIDER_BY_ID: Readonly<
  Record<string, WorkspaceAgentProvider>
> = {
  "agent-claude-code": "claude-code",
  "agent-codex": "codex"
};

function isLegacyAgentWorkspaceAppMentionId(appId: string): boolean {
  return (
    WORKSPACE_AGENT_APP_PROVIDER_BY_ID[appId.trim().toLowerCase()] !== undefined
  );
}

function shouldShowReadyAgentTarget(input: {
  agentProviderStatuses?: readonly AgentProviderStatus[];
  provider: WorkspaceAgentProvider;
}): boolean {
  if (input.agentProviderStatuses === undefined) {
    return true;
  }
  // UI-only guard for agent targets. This reads an existing renderer
  // snapshot and must not trigger provider availability/auth probing.
  return input.agentProviderStatuses.some(
    (status) =>
      status.provider === input.provider &&
      status.availability.status === "ready"
  );
}

function workspaceAppIconUrl(
  candidate: Awaited<
    ReturnType<TuttidClient["listWorkspaceAppMentionCandidates"]>
  >["apps"][number],
  appId: string
): string | null {
  return (
    candidate.iconUrl?.trim() ||
    candidate.availableIconUrl?.trim() ||
    resolveDesktopWorkspaceAppDefaultIconUrl(appId)
  );
}

function workspaceAppMatchesKeyword(
  item: WorkspaceAppAtItem,
  keyword: string
): boolean {
  if (!keyword) {
    return true;
  }
  const haystack = [
    item.appId,
    item.displayName,
    item.description,
    ...item.scopes,
    ...item.commandPaths,
    ...item.commandSummaries,
    ...item.commandDescriptions
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(keyword);
}

function findWorkspaceAppMentionLocalization(
  app: Awaited<
    ReturnType<TuttidClient["listWorkspaceAppMentionCandidates"]>
  >["apps"][number],
  locale: string
): (typeof app.localizations)[number] | null {
  const normalizedLocale = normalizeLocale(locale);
  if (!normalizedLocale || app.localizations.length === 0) {
    return null;
  }

  const exact = app.localizations.find(
    (localization) => normalizeLocale(localization.locale) === normalizedLocale
  );
  if (exact) {
    return exact;
  }

  const language = normalizedLocale.split("-")[0];
  return (
    app.localizations.find(
      (localization) =>
        normalizeLocale(localization.locale)?.split("-")[0] === language
    ) ?? null
  );
}

function findBuiltInWorkspaceAppMetadata(
  appId: string,
  locale: string
): BuiltInWorkspaceAppMetadata | null {
  const normalizedLocale = normalizeLocale(locale);
  const language = normalizedLocale?.split("-")[0] ?? "en";
  const id = appId.trim().toLowerCase();
  const resource =
    language === "zh"
      ? appCenterI18nResources["zh-CN"]
      : appCenterI18nResources.en;
  const agentAppMetadata = builtInAgentWorkspaceAppMetadataFromResource(
    resource,
    id
  );
  if (agentAppMetadata) {
    return agentAppMetadata;
  }
  if (id !== "issue-manager") {
    return null;
  }
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

function builtInAgentWorkspaceAppMetadataFromResource(
  resource: unknown,
  appId: string
): BuiltInWorkspaceAppMetadata | null {
  const { catalogApps } = (resource as BuiltInWorkspaceAppResource).appCenter;
  if (appId === "agent-claude-code") {
    return catalogApps.agentClaudeCode;
  }
  if (appId === "agent-codex") {
    return catalogApps.agentCodex;
  }
  return null;
}

function normalizeLocale(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/_/gu, "-").toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function createProviderCacheKey(
  input: DesktopRichTextTriggerProviderRequest,
  capabilities: ReadonlySet<DesktopRichTextAtCapability>
): string {
  return JSON.stringify({
    capabilities: [...capabilities].sort(),
    surface: input.surface,
    target: input.target,
    workspaceId: input.workspaceId
  });
}

function resolveWorkspaceFileLabel(item: WorkspaceFileAtItem): string {
  const displayName = item.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const name = item.name?.trim();
  if (name) {
    return name;
  }

  const path = item.path.trim();
  return path.split("/").filter(Boolean).at(-1) || path;
}

function createDesktopRichTextMentionInsertResult(
  mention: RichTextMentionInsert
) {
  return createRichTextMentionInsertResult(mention);
}

function compactStringRecord(
  values: Readonly<Record<string, string | null | undefined>>
): Readonly<Record<string, string>> | undefined {
  const entries = Object.entries(values)
    .map(([key, value]) => [key.trim(), value?.trim() ?? ""] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactMentionPresentation(
  presentation: RichTextMentionPresentation
): RichTextMentionPresentation | undefined {
  const compacted: RichTextMentionPresentation = {};
  for (const key of RICH_TEXT_MENTION_PRESENTATION_KEYS) {
    const value = presentation[key]?.trim();
    if (value) {
      compacted[key] = value;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function scopeString(
  scope: Readonly<Record<string, string>> | undefined,
  key: string
): string {
  return scope?.[key]?.trim() ?? "";
}

async function resolveMentionSafely(
  resolve: () => Promise<RichTextMentionResolved | null>
): Promise<RichTextMentionResolved | null> {
  try {
    return await resolve();
  } catch {
    return null;
  }
}

function isIssueWorkspaceRuntimePath(path: string, root: string): boolean {
  const trimmed = path.trim();
  const normalizedRoot = root.trim().replace(/\/+$/, "");
  if (!normalizedRoot) {
    return false;
  }
  const issueRoot = `${normalizedRoot}/issues`;
  return trimmed === issueRoot || trimmed.startsWith(`${issueRoot}/`);
}

function createWorkspaceFileAtContributor(
  tuttidClient: TuttidClient
): DesktopRichTextAtContributor {
  return {
    capability: "file",
    getProviders(input) {
      return [
        createRichTextTriggerProvider<WorkspaceFileAtItem>({
          id: FILE_PROVIDER_ID,
          trigger: "@",
          async query(searchInput) {
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            const response = await tuttidClient.searchWorkspaceFiles(
              input.workspaceId,
              {
                limit: searchInput.maxResults,
                query: searchInput.keyword
              },
              {
                signal: searchInput.abortSignal
              }
            );
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            return response.entries
              .filter(
                (entry) =>
                  !isIssueWorkspaceRuntimePath(entry.path, response.root)
              )
              .map((entry) => ({
                displayName: entry.name,
                kind: entry.kind,
                path: entry.path
              }));
          },
          getItemKey: (item) => item.path,
          getItemLabel: resolveWorkspaceFileLabel,
          getItemSubtitle: (item) => item.path.trim(),
          getItemIconUrl: workspaceFileIconUrl,
          toInsertResult(item) {
            return createRichTextMarkdownLinkInsertResult(
              resolveWorkspaceFileLabel(item),
              workspaceFileReferenceHref(item)
            );
          }
        })
      ];
    }
  };
}

function workspaceFileReferenceHref(item: WorkspaceFileAtItem): string {
  const path = item.path.trim();
  if (item.kind === "directory" && path && !path.endsWith("/")) {
    return `${path}/`;
  }
  return path;
}

function workspaceFileIconUrl(item: WorkspaceFileAtItem): string {
  return item.kind === "directory"
    ? tuttiFolderAssetUrls.default
    : tuttiFileAssetUrls.default;
}

function createWorkspaceIssueAtContributor(
  tuttidClient: TuttidClient
): DesktopRichTextAtContributor {
  return {
    capability: "workspace-issue",
    getProviders(input) {
      return [
        createRichTextTriggerProvider<WorkspaceIssueAtItem>({
          id: WORKSPACE_ISSUE_PROVIDER_ID,
          trigger: "@",
          async query(searchInput) {
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            const topicResponse = await tuttidClient.listWorkspaceIssueTopics(
              input.workspaceId
            );
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            const topicId = topicResponse.topics[0]?.topicId;
            if (!topicId) {
              return [];
            }
            const response = await tuttidClient.listWorkspaceIssues(
              input.workspaceId,
              {
                pageSize: searchInput.maxResults,
                searchQuery: searchInput.keyword,
                topicId
              }
            );
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            const items = response.issues.map(workspaceIssueAtItemFromIssue);
            const issueId = workspaceIssueIdSearchKeyword(searchInput.keyword);
            if (!issueId || items.some((item) => item.issueId === issueId)) {
              return items;
            }
            const detail = await getWorkspaceIssueDetailSafely(
              tuttidClient,
              input.workspaceId,
              issueId
            );
            if (!detail) {
              return items;
            }
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            return [workspaceIssueAtItemFromIssue(detail.issue), ...items];
          },
          getItemKey: (item) => item.issueId,
          getItemLabel: (item) => item.title,
          getItemSubtitle: (item) =>
            [item.status, item.creatorDisplayName, item.content]
              .map((value) => value?.trim() ?? "")
              .filter(Boolean)
              .join(" · "),
          getItemIconUrl: () => tuttiIssueAssetUrls.default,
          toInsertResult(item) {
            return createDesktopRichTextMentionInsertResult({
              entityId: item.issueId,
              label: item.title,
              scope: compactStringRecord({
                topicId: item.topicId,
                workspaceId: item.workspaceId
              }),
              presentation: compactMentionPresentation({
                description: item.content?.trim() ?? "",
                iconUrl: tuttiIssueAssetUrls.default,
                status: item.status?.trim() ?? ""
              })
            });
          },
          async resolveMention(identity) {
            const workspaceId = scopeString(identity.scope, "workspaceId");
            if (!workspaceId) {
              return null;
            }
            return resolveMentionSafely(async () => {
              const response = await tuttidClient.getWorkspaceIssueDetail(
                workspaceId,
                identity.entityId
              );
              const issue = response.issue;
              return {
                label: issue.title,
                presentation: compactMentionPresentation({
                  description: issue.content,
                  iconUrl: tuttiIssueAssetUrls.default,
                  status: issue.status
                })
              };
            });
          }
        })
      ];
    }
  };
}

async function getWorkspaceIssueDetailSafely(
  tuttidClient: TuttidClient,
  workspaceId: string,
  issueId: string
): Promise<Awaited<
  ReturnType<TuttidClient["getWorkspaceIssueDetail"]>
> | null> {
  try {
    return await tuttidClient.getWorkspaceIssueDetail(workspaceId, issueId);
  } catch {
    return null;
  }
}

function workspaceIssueAtItemFromIssue(issue: {
  content?: string | null;
  creatorDisplayName?: string | null;
  issueId: string;
  status?: string | null;
  title: string;
  topicId: string;
  workspaceId: string;
}): WorkspaceIssueAtItem {
  return {
    content: issue.content,
    creatorDisplayName: issue.creatorDisplayName,
    issueId: issue.issueId,
    status: issue.status,
    title: issue.title,
    topicId: issue.topicId,
    workspaceId: issue.workspaceId
  };
}

function workspaceIssueIdSearchKeyword(keyword: string): string | null {
  const issueId = keyword.trim();
  return /^issue-[A-Za-z0-9_-]+$/.test(issueId) ? issueId : null;
}

function createAgentTargetAtContributor(contributorInput: {
  agentsService?: Pick<IAgentsService, "load">;
  agentProviderStatuses?: () => readonly AgentProviderStatus[] | undefined;
}): DesktopRichTextAtContributor {
  return {
    capability: "agent-target",
    getProviders(input) {
      return [
        createRichTextTriggerProvider<AgentTargetAtItem>({
          id: AGENT_TARGET_PROVIDER_ID,
          trigger: "@",
          async query(searchInput) {
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            const response = await contributorInput.agentsService?.load(
              searchInput.abortSignal
            );
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            if (!response) {
              return [];
            }
            return agentTargetAtItemsFromTargets({
              agentProviderStatuses: contributorInput.agentProviderStatuses?.(),
              keyword: searchInput.keyword,
              maxResults: searchInput.maxResults,
              targets: response.agentTargets,
              workspaceId: input.workspaceId
            });
          },
          getItemKey: (item) => item.targetId,
          getItemLabel: (item) => item.displayName,
          getItemSubtitle: (item) => item.description,
          getItemIconUrl: (item) => item.iconUrl,
          toInsertResult(item) {
            return createDesktopRichTextMentionInsertResult({
              entityId: item.targetId,
              label: item.displayName,
              scope: compactStringRecord({
                workspaceId: item.workspaceId
              }),
              presentation: compactMentionPresentation({
                agentProviderId: item.provider,
                description: item.description,
                iconUrl: item.iconUrl,
                subtitle: item.description
              })
            });
          },
          async resolveMention(identity) {
            const workspaceId = scopeString(identity.scope, "workspaceId");
            if (!workspaceId) {
              return null;
            }
            return resolveMentionSafely(async () => {
              const response = await contributorInput.agentsService?.load();
              if (!response) {
                return null;
              }
              const item = agentTargetAtItemsFromTargets({
                agentProviderStatuses:
                  contributorInput.agentProviderStatuses?.(),
                keyword: "",
                targets: response.agentTargets,
                workspaceId
              }).find((target) => target.targetId === identity.entityId);
              if (!item) {
                return null;
              }
              return {
                label: item.displayName,
                presentation: compactMentionPresentation({
                  agentProviderId: item.provider,
                  description: item.description,
                  iconUrl: item.iconUrl,
                  subtitle: item.description
                })
              };
            });
          }
        })
      ];
    }
  };
}

function agentTargetAtItemsFromTargets(input: {
  agentProviderStatuses?: readonly AgentProviderStatus[];
  keyword: string;
  maxResults?: number;
  targets: readonly AgentTargetPresentation[];
  workspaceId: string;
}): AgentTargetAtItem[] {
  const keyword = input.keyword.trim().toLowerCase();
  const items = input.targets
    .filter((target) => target.enabled)
    .map((target): AgentTargetAtItem | null => {
      const provider = normalizeWorkspaceAgentProvider(target.provider);
      if (!provider) {
        return null;
      }
      if (
        !shouldShowReadyAgentTarget({
          agentProviderStatuses: input.agentProviderStatuses,
          provider
        })
      ) {
        return null;
      }
      const targetId = target.agentTargetId.trim();
      if (!targetId) {
        return null;
      }
      const label =
        normalizeText(target.name) ??
        resolveAgentSessionProviderLabel(provider);
      const description = normalizeText(target.name) ?? label;
      return {
        description,
        displayName: label,
        iconUrl: target.iconUrl,
        provider,
        targetId,
        workspaceId: input.workspaceId
      };
    })
    .filter((item): item is AgentTargetAtItem => item !== null)
    .filter((item) => agentTargetMatchesKeyword(item, keyword))
    .sort(compareAgentTargetAtItems);
  return input.maxResults === undefined
    ? items
    : items.slice(0, Math.max(0, input.maxResults));
}

function normalizeWorkspaceAgentProvider(
  provider: string
): WorkspaceAgentProvider | null {
  switch (provider.trim()) {
    case "claude-code":
      return "claude-code";
    case "codex":
      return "codex";
    default:
      return null;
  }
}

function agentTargetMatchesKeyword(
  item: AgentTargetAtItem,
  keyword: string
): boolean {
  if (!keyword) {
    return true;
  }
  return [item.targetId, item.provider, item.displayName, item.description]
    .join("\n")
    .toLowerCase()
    .includes(keyword);
}

function compareAgentTargetAtItems(
  left: AgentTargetAtItem,
  right: AgentTargetAtItem
): number {
  const providerOrder =
    agentTargetProviderRank(left.provider) -
    agentTargetProviderRank(right.provider);
  if (providerOrder !== 0) {
    return providerOrder;
  }
  const labelOrder = left.displayName.localeCompare(
    right.displayName,
    undefined,
    {
      sensitivity: "base"
    }
  );
  if (labelOrder !== 0) {
    return labelOrder;
  }
  return left.targetId.localeCompare(right.targetId);
}

function agentTargetProviderRank(provider: WorkspaceAgentProvider): number {
  return provider === "codex" ? 0 : 1;
}

function createAgentSessionAtContributor(
  tuttidClient: TuttidClient
): DesktopRichTextAtContributor {
  return {
    capability: "agent-session",
    getProviders(input) {
      return [
        createRichTextTriggerProvider<AgentSessionAtItem>({
          id: AGENT_SESSION_PROVIDER_ID,
          trigger: "@",
          async query(searchInput) {
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            const currentUserId = metadataString(
              searchInput.context.metadata,
              "currentUserId"
            );
            const response = await tuttidClient.listWorkspaceAgentSessions(
              input.workspaceId,
              {
                limit: searchInput.maxResults,
                searchQuery: searchInput.keyword.trim()
              }
            );
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            return response.sessions.map((session) => ({
              agentName: resolveAgentSessionProviderLabel(session.provider),
              createdAtUnixMs: dateTimeToUnixMs(session.createdAt),
              id: session.id,
              initiatorName: "local",
              provider: session.provider,
              scope: resolveAgentSessionScope(currentUserId, "local"),
              sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
              status: session.status,
              title: session.title,
              updatedAtUnixMs: dateTimeToUnixMs(
                session.updatedAt ?? session.createdAt
              ),
              userId: "local",
              workspaceId: response.workspaceId || input.workspaceId
            }));
          },
          getItemKey: (item) => item.id,
          getItemLabel: resolveAgentSessionLabel,
          getItemSubtitle: (item) =>
            [item.provider, item.status]
              .map((value) => value?.trim() ?? "")
              .filter(Boolean)
              .join(" · "),
          toInsertResult(item) {
            return createDesktopRichTextMentionInsertResult({
              entityId: item.id,
              label: resolveAgentSessionLabel(item),
              scope: compactStringRecord({
                scope: item.scope,
                userId: item.userId,
                workspaceId: item.workspaceId
              }),
              presentation: compactMentionPresentation({
                agentProviderId: item.provider?.trim() ?? "",
                participant: [item.initiatorName, item.agentName]
                  .map((value) => value?.trim() ?? "")
                  .filter(Boolean)
                  .join(" & "),
                status: item.status?.trim() ?? "",
                subtitle: item.agentName?.trim() ?? ""
              })
            });
          },
          async resolveMention(identity) {
            const workspaceId = scopeString(identity.scope, "workspaceId");
            if (!workspaceId) {
              return null;
            }
            return resolveMentionSafely(async () => {
              const session = await tuttidClient.getWorkspaceAgentSession(
                workspaceId,
                identity.entityId
              );
              return {
                label: resolveAgentSessionLabel({
                  id: session.id,
                  provider: session.provider,
                  title: session.title,
                  workspaceId
                }),
                presentation: compactMentionPresentation({
                  agentProviderId: session.provider,
                  status: session.status,
                  subtitle: resolveAgentSessionProviderLabel(session.provider)
                })
              };
            });
          }
        })
      ];
    }
  };
}

function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string
): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function resolveAgentSessionScope(
  currentUserId: string,
  userId: string
): NonNullable<AgentSessionAtItem["scope"]> {
  const normalizedCurrentUserId = currentUserId.trim();
  const normalizedUserId = userId.trim();
  if (
    !normalizedCurrentUserId ||
    !normalizedUserId ||
    normalizedCurrentUserId === "local" ||
    normalizedUserId === "local"
  ) {
    return "my_sessions";
  }
  return normalizedCurrentUserId === normalizedUserId
    ? "my_sessions"
    : "collab_sessions";
}

function resolveAgentSessionLabel(item: AgentSessionAtItem): string {
  const title = normalizeAgentTitleText(item.title);
  if (title) {
    return title;
  }
  const provider = item.provider?.trim();
  return provider ? `${provider} session` : item.id;
}

function resolveAgentSessionProviderLabel(provider?: string | null): string {
  switch (provider?.trim()) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini CLI";
    case "hermes":
      return "Hermes Agent";
    case "nexight":
      return "Nexight";
    case "openclaw":
      return "OpenClaw";
    default:
      return provider?.trim() || "";
  }
}

function dateTimeToUnixMs(value?: string | null): number | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  const unixMs = Date.parse(trimmed);
  return Number.isFinite(unixMs) ? unixMs : null;
}
