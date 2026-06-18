import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import { normalizeAgentTitleText } from "@tutti-os/agent-gui/agent-title-text";
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
  tuttiAgentAssetUrls,
  tuttiFileAssetUrls,
  tuttiFolderAssetUrls,
  tuttiIssueAssetUrls
} from "../../../../../../shared/tuttiAssetProtocol.ts";
import type {
  DesktopRichTextAtCapability,
  DesktopRichTextTriggerProviderRequest,
  IDesktopRichTextAtService
} from "../richTextAtService.interface";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import { createDesktopWorkspaceAppMentionProvider } from "../../providers/desktopWorkspaceAppMentionProvider.ts";
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
  tuttidClient: TuttidClient;
  /**
   * Live getter for the workspace App Center app snapshot. Read at query time so
   * the enriched `workspace-app` provider keeps localized name/description + icon
   * in sync with app updates. Optional so non-desktop callers/tests stay raw.
   */
  appCenterApps?: () => readonly WorkspaceAppCenterApp[];
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

interface WorkspaceAppAtItem {
  appId: string;
  commandCount: number;
  commandDescriptions: string[];
  commandPaths: string[];
  description: string;
  commandSummaries: string[];
  displayName: string;
  iconUrl: string | null;
  scopes: string[];
  workspaceId: string;
}

const {
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
  "userAvatarPlaceholderUrl"
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
      createAgentSessionAtContributor(dependencies.tuttidClient),
      createWorkspaceAppAtContributor(dependencies.tuttidClient)
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
        return this.enrichProviders(cachedProviders, input);
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
    return this.enrichProviders(providers, input);
  }

  private enrichProviders(
    providers: readonly RichTextTriggerProvider[],
    input: DesktopRichTextTriggerProviderRequest
  ): readonly RichTextTriggerProvider[] {
    const deps = this.dependencies;
    const resolveAgentIconUrl = deps.resolveAgentIconUrl;
    const userAvatarPlaceholderUrl = deps.userAvatarPlaceholderUrl;
    const resolveSessionStatusView = deps.resolveSessionStatusView;
    const canEnrichApp =
      deps.appCenterApps !== undefined && deps.getLocale !== undefined;
    const canEnrichSession =
      resolveAgentIconUrl !== undefined &&
      userAvatarPlaceholderUrl !== undefined &&
      resolveSessionStatusView !== undefined;
    if (!canEnrichApp && !canEnrichSession) {
      return providers;
    }
    return providers.map((provider): RichTextTriggerProvider => {
      if (canEnrichApp && provider.id === WORKSPACE_APP_PROVIDER_ID) {
        return createDesktopWorkspaceAppMentionProvider({
          apps: deps.appCenterApps?.() ?? [],
          baseProvider: provider as unknown as AgentContextMentionProvider,
          locale: deps.getLocale?.() ?? "",
          workspaceId: input.workspaceId
        });
      }
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

function createWorkspaceAppAtContributor(
  tuttidClient: TuttidClient
): DesktopRichTextAtContributor {
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
            const response = await tuttidClient.listCliCapabilities(
              input.workspaceId
            );
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            return workspaceAppAtItemsFromCapabilities({
              commands: response.commands,
              keyword: searchInput.keyword,
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
                await tuttidClient.listCliCapabilities(workspaceId);
              const item = workspaceAppAtItemsFromCapabilities({
                commands: response.commands,
                keyword: "",
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

function workspaceAppAtItemsFromCapabilities(input: {
  commands: Awaited<
    ReturnType<TuttidClient["listCliCapabilities"]>
  >["commands"];
  keyword: string;
  maxResults?: number;
  workspaceId: string;
}): WorkspaceAppAtItem[] {
  const appsById = new Map<string, WorkspaceAppAtItem>();
  for (const command of input.commands) {
    if (command.source.kind !== "app") {
      continue;
    }
    const appId = command.source.appId?.trim() ?? "";
    if (!appId) {
      continue;
    }
    const sourceIconUrl = command.source.iconUrl?.trim() || null;
    const iconUrl = workspaceAppIconUrl(command, appId);
    const appName = command.source.appName?.trim() || appId;
    const existing = appsById.get(appId);
    const item =
      existing ??
      ({
        appId,
        commandCount: 0,
        commandDescriptions: [],
        commandPaths: [],
        description: "",
        commandSummaries: [],
        displayName: appName,
        iconUrl,
        scopes: [],
        workspaceId: input.workspaceId
      } satisfies WorkspaceAppAtItem);
    item.commandCount += 1;
    if (sourceIconUrl || !item.iconUrl) {
      item.iconUrl = iconUrl;
    }
    const description = workspaceAppDescriptionFromCapability(command);
    if (description && !item.description) {
      item.description = description;
    }
    const scope = command.path[0]?.trim() ?? "";
    if (scope && !item.scopes.includes(scope)) {
      item.scopes.push(scope);
    }
    const commandPath = command.path.join(" ").trim();
    if (commandPath && !item.commandPaths.includes(commandPath)) {
      item.commandPaths.push(commandPath);
    }
    const summary = command.summary.trim();
    if (summary && !item.commandSummaries.includes(summary)) {
      item.commandSummaries.push(summary);
    }
    const commandDescription = command.description?.trim() ?? "";
    if (
      commandDescription &&
      !item.commandDescriptions.includes(commandDescription)
    ) {
      item.commandDescriptions.push(commandDescription);
    }
    appsById.set(appId, item);
  }

  const keyword = input.keyword.trim().toLowerCase();
  const apps = [...appsById.values()]
    .filter((app) => workspaceAppMatchesKeyword(app, keyword))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  return apps;
}

function workspaceAppIconUrl(
  command: Awaited<
    ReturnType<TuttidClient["listCliCapabilities"]>
  >["commands"][number],
  appId: string
): string | null {
  return command.source.iconUrl?.trim() || workspaceAppDefaultIconUrl(appId);
}

function workspaceAppDefaultIconUrl(appId: string): string | null {
  switch (appId.trim()) {
    case "agent-claude-code":
      return tuttiAgentAssetUrls.claudeCode;
    case "agent-codex":
      return tuttiAgentAssetUrls.codex;
    case "issue-manager":
      return tuttiIssueAssetUrls.default;
    default:
      return null;
  }
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

function workspaceAppDescriptionFromCapability(
  command: Awaited<
    ReturnType<TuttidClient["listCliCapabilities"]>
  >["commands"][number]
): string {
  return (
    command.source.cliDescription?.trim() ||
    command.source.appDescription?.trim() ||
    ""
  );
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
                searchQuery: searchInput.keyword.trim(),
                visibleOnly: true
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
