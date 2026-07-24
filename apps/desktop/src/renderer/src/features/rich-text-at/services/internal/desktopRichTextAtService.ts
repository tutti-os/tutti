import type {
  AgentProviderStatus,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import { appCenterI18nResources } from "@tutti-os/workspace-app-center/i18n";
import {
  createRichTextMarkdownLinkInsertResult,
  createRichTextTriggerProvider
} from "@tutti-os/ui-rich-text/plugins";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import {
  tuttiFileAssetUrls,
  tuttiFolderAssetUrls
} from "../../../../../../shared/tuttiAssetProtocol.ts";
import type { IAgentsService } from "../../../workspace-agent/services/agentsService.interface";
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
import {
  createAgentSessionAtContributor,
  createAgentTargetAtContributor
} from "./desktopRichTextAtAgentContributors.ts";
import { createWorkspaceModelAtContributor } from "./desktopRichTextAtModelContributor.ts";
import {
  compactMentionPresentation,
  compactStringRecord,
  createDesktopRichTextMentionInsertResult,
  resolveMentionSafely,
  scopeString,
  type DesktopRichTextAtContributor
} from "./desktopRichTextAtMentionSupport.ts";
import { createWorkspaceIssueAtContributor } from "./desktopWorkspaceIssueAtContributor.ts";

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
  /** Live getter for the renderer-local Tutti Agent entry switch. */
  isTuttiAgentSwitchEnabled?: () => boolean;
}

interface WorkspaceFileAtItem {
  displayName?: string | null;
  displayPath: string;
  kind?: "directory" | "file" | (string & {});
  name?: string | null;
  path: string;
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
  agentSession: AGENT_SESSION_PROVIDER_ID,
  file: FILE_PROVIDER_ID,
  workspaceApp: WORKSPACE_APP_PROVIDER_ID
} = AGENT_CONTEXT_MENTION_PROVIDER_IDS;

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
        agentProviderStatuses: dependencies.agentProviderStatuses,
        isTuttiAgentSwitchEnabled: dependencies.isTuttiAgentSwitchEnabled
      }),
      createAgentSessionAtContributor({
        agentsService: dependencies.agentsService,
        tuttidClient: dependencies.tuttidClient
      }),
      createWorkspaceAppAtContributor({
        tuttidClient: dependencies.tuttidClient,
        getLocale: dependencies.getLocale
      }),
      createWorkspaceModelAtContributor(dependencies.tuttidClient)
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
    if (
      !shouldShowWorkspaceAppMentionCandidate({
        appId
      })
    ) {
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
  "agent-codex": "codex",
  "agent-tutti-agent": "tutti-agent"
};

function shouldShowWorkspaceAppMentionCandidate(input: {
  appId: string;
}): boolean {
  const provider =
    WORKSPACE_AGENT_APP_PROVIDER_BY_ID[input.appId.trim().toLowerCase()];
  return provider === undefined;
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
  return item.displayName.toLowerCase().includes(keyword);
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
  if (appId === "agent-tutti-agent") {
    return {
      // i18n-check-ignore: Provider brand name.
      description: "Tutti Agent",
      // i18n-check-ignore: Provider brand name.
      name: "Tutti Agent"
    };
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
                displayPath: workspaceRelativeDisplayPath(
                  entry.path,
                  response.root,
                  entry.name
                ),
                kind: entry.kind,
                path: entry.path
              }));
          },
          getItemKey: (item) => item.path,
          getItemLabel: resolveWorkspaceFileLabel,
          getItemSubtitle: (item) => item.displayPath,
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

function workspaceRelativeDisplayPath(
  path: string,
  root: string,
  fallbackName: string
): string {
  const normalizedPath = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRoot = root.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    normalizedRoot &&
    (normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(`${normalizedRoot}/`))
  ) {
    return (
      normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "") ||
      fallbackName
    );
  }
  return fallbackName;
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
