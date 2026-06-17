import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { AGENT_GUI_MENTION_PROVIDER_IDS } from "@tutti-os/agent-gui/agent-rich-text-at-provider";
import { normalizeAgentTitleText } from "@tutti-os/agent-gui/agent-title-text";
import { buildWorkspaceIssueMentionHref } from "@tutti-os/workspace-issue-manager/core";
import {
  createRichTextAtProvider,
  createRichTextMarkdownLinkInsertResult,
  createRichTextMentionInsertResult
} from "@tutti-os/ui-rich-text/plugins";
import type {
  RichTextAtProvider,
  RichTextAtQueryInput
} from "@tutti-os/ui-rich-text/types";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import type {
  DesktopRichTextAtCapability,
  DesktopRichTextAtProviderRequest,
  IDesktopRichTextAtService
} from "../richTextAtService.interface";
import { createDesktopWorkspaceAppMentionProvider } from "../../providers/desktopWorkspaceAppMentionProvider.ts";
import {
  createDesktopAgentSessionMentionProvider,
  type DesktopAgentSessionStatusView
} from "../../providers/desktopAgentSessionMentionProvider.ts";

interface DesktopRichTextAtContributor {
  capability: DesktopRichTextAtCapability;
  getProviders: (
    input: DesktopRichTextAtProviderRequest
  ) => readonly RichTextAtProvider<unknown>[];
}

export interface DesktopRichTextAtServiceDependencies {
  tuttidClient: TuttidClient;
  /**
   * Live getter for the workspace App Center app snapshot. Read at query time so
   * the enriched `workspace-app` provider keeps localized name/description + icon
   * in sync with app updates. Optional so non-desktop callers/tests stay raw.
   */
  appCenterApps?: () => readonly WorkspaceAppCenterApp[];
  /** Resolve the bundled dock icon URL for an app id. */
  resolveAppIconUrl?: (appId: string) => string | null;
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
} = AGENT_GUI_MENTION_PROVIDER_IDS;

const agentClaudeCodeAppIconUrl = new URL(
  "../../../../assets/workspace-canvas/dock/default/claudecode.png",
  import.meta.url
).href;
const agentCodexAppIconUrl = new URL(
  "../../../../assets/workspace-canvas/dock/default/codex.png",
  import.meta.url
).href;

const agentWorkspaceAppIconUrls = new Map<string, string>([
  ["agent-claude-code", agentClaudeCodeAppIconUrl],
  ["agent-codex", agentCodexAppIconUrl]
]);

export class DesktopRichTextAtService implements IDesktopRichTextAtService {
  readonly _serviceBrand = undefined;
  private readonly contributors: readonly DesktopRichTextAtContributor[];
  private readonly dependencies: DesktopRichTextAtServiceDependencies;
  private readonly providerCache = new Map<
    string,
    readonly RichTextAtProvider[]
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
    input: DesktopRichTextAtProviderRequest
  ): readonly RichTextAtProvider[] {
    const requestedCapabilities = new Set(input.capabilities);
    if (requestedCapabilities.size === 0) {
      return [];
    }

    const cacheKey =
      input.metadata === undefined
        ? createProviderCacheKey(input, requestedCapabilities)
        : null;
    let baseProviders: readonly RichTextAtProvider[] | undefined;
    if (cacheKey !== null) {
      baseProviders = this.providerCache.get(cacheKey);
    }
    if (!baseProviders) {
      baseProviders = this.contributors.flatMap((contributor) =>
        requestedCapabilities.has(contributor.capability)
          ? contributor.getProviders(input)
          : []
      );
      if (cacheKey !== null) {
        this.providerCache.set(cacheKey, baseProviders);
      }
    }
    // Enrich AFTER the cache so the enriched providers read the live app/locale
    // snapshot per query (the wrapper modules capture apps/locale at construction).
    const enrichedProviders = this.enrichProviders(baseProviders, input);
    return withRichTextAtRequestMetadata(enrichedProviders, input.metadata);
  }

  private enrichProviders(
    providers: readonly RichTextAtProvider[],
    input: DesktopRichTextAtProviderRequest
  ): readonly RichTextAtProvider[] {
    const deps = this.dependencies;
    const canEnrichApp =
      deps.appCenterApps !== undefined && deps.getLocale !== undefined;
    const canEnrichSession =
      deps.resolveAgentIconUrl !== undefined &&
      deps.userAvatarPlaceholderUrl !== undefined &&
      deps.resolveSessionStatusView !== undefined;
    if (!canEnrichApp && !canEnrichSession) {
      return providers;
    }
    return providers.map((provider): RichTextAtProvider => {
      if (canEnrichApp && provider.id === WORKSPACE_APP_PROVIDER_ID) {
        const enrichedAppProvider = createDesktopWorkspaceAppMentionProvider({
          apps: deps.appCenterApps?.() ?? [],
          baseProvider: provider,
          locale: deps.getLocale?.() ?? "",
          resolveAppIconUrl: deps.resolveAppIconUrl,
          workspaceId: input.workspaceId
        });
        // The wrapped provider is typed RichTextAtProvider<DesktopWorkspaceAppMentionItem>,
        // which tsc rejects against RichTextAtProvider<unknown> (contravariant
        // getItemKey); the cast bridges that variance.
        return enrichedAppProvider as unknown as RichTextAtProvider;
      }
      if (canEnrichSession && provider.id === AGENT_SESSION_PROVIDER_ID) {
        return createDesktopAgentSessionMentionProvider({
          baseProvider: provider,
          resolveAgentIconUrl: deps.resolveAgentIconUrl!,
          userAvatarPlaceholderUrl: deps.userAvatarPlaceholderUrl!,
          resolveStatusView: deps.resolveSessionStatusView!
        });
      }
      return provider;
    });
  }
}

function withRichTextAtRequestMetadata(
  providers: readonly RichTextAtProvider[],
  metadata: Readonly<Record<string, unknown>> | undefined
): readonly RichTextAtProvider[] {
  if (!metadata) {
    return providers;
  }
  return providers.map((provider) => ({
    ...provider,
    query: (input) =>
      provider.query(withRichTextAtQueryMetadata(input, metadata)),
    ...(provider.getItemReferenceItems
      ? {
          getItemReferenceItems: (item, input) =>
            provider.getItemReferenceItems?.(
              item,
              withRichTextAtQueryMetadata(input, metadata)
            ) ?? []
        }
      : {})
  }));
}

function withRichTextAtQueryMetadata(
  input: RichTextAtQueryInput,
  metadata: Readonly<Record<string, unknown>>
): RichTextAtQueryInput {
  return {
    ...input,
    context: {
      ...input.context,
      metadata: {
        ...metadata,
        ...(input.context.metadata ?? {})
      }
    }
  };
}

function createWorkspaceAppAtContributor(
  tuttidClient: TuttidClient
): DesktopRichTextAtContributor {
  return {
    capability: "workspace-app",
    getProviders(input) {
      return [
        createRichTextAtProvider<WorkspaceAppAtItem>({
          id: WORKSPACE_APP_PROVIDER_ID,
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
          toInsertResult(item) {
            return createRichTextMentionInsertResult({
              entityId: item.appId,
              href: buildMentionHref(WORKSPACE_APP_PROVIDER_ID, {
                appId: item.appId,
                workspaceId: item.workspaceId
              }),
              kind: WORKSPACE_APP_PROVIDER_ID,
              label: item.displayName,
              meta: {
                appId: item.appId,
                commandCount: String(item.commandCount),
                commandDescriptions: item.commandDescriptions.join("\n"),
                commandPaths: item.commandPaths.join("\n"),
                commandSummaries: item.commandSummaries.join("\n"),
                description: item.description,
                iconUrl: item.iconUrl ?? "",
                scopes: item.scopes.join(","),
                workspaceId: item.workspaceId
              }
            });
          }
        }) as RichTextAtProvider<unknown>
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
  return (
    command.source.iconUrl?.trim() ||
    agentWorkspaceAppIconUrls.get(appId) ||
    null
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
  input: DesktopRichTextAtProviderRequest,
  capabilities: ReadonlySet<DesktopRichTextAtCapability>
): string {
  return JSON.stringify({
    capabilities: [...capabilities].sort(),
    surface: input.surface,
    target: input.target,
    workspaceId: input.workspaceId
  });
}

function normalizeWorkspaceFileHref(
  pathOrHref: string,
  kind: "file" | "folder" = "file"
): string {
  const trimmed = pathOrHref.trim();
  if (!trimmed) {
    return "";
  }

  if (kind === "folder" && !trimmed.endsWith("/")) {
    return `${trimmed}/`;
  }

  return trimmed;
}

function resolveWorkspaceFileKind(
  kind?: WorkspaceFileAtItem["kind"]
): "file" | "folder" {
  return kind === "directory" ? "folder" : "file";
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
    capability: "workspace-file",
    getProviders(input) {
      return [
        createRichTextAtProvider<WorkspaceFileAtItem>({
          id: FILE_PROVIDER_ID,
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
          toInsertResult(item) {
            return createRichTextMarkdownLinkInsertResult(
              resolveWorkspaceFileLabel(item),
              normalizeWorkspaceFileHref(
                item.path,
                resolveWorkspaceFileKind(item.kind)
              )
            );
          }
        }) as RichTextAtProvider<unknown>
      ];
    }
  };
}

function createWorkspaceIssueAtContributor(
  tuttidClient: TuttidClient
): DesktopRichTextAtContributor {
  return {
    capability: "workspace-issue",
    getProviders(input) {
      return [
        createRichTextAtProvider<WorkspaceIssueAtItem>({
          id: WORKSPACE_ISSUE_PROVIDER_ID,
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
            return response.issues.map((issue) => ({
              content: issue.content,
              creatorDisplayName: issue.creatorDisplayName,
              issueId: issue.issueId,
              status: issue.status,
              title: issue.title,
              topicId: issue.topicId,
              workspaceId: issue.workspaceId
            }));
          },
          getItemKey: (item) => item.issueId,
          getItemLabel: (item) => item.title,
          getItemSubtitle: (item) =>
            [item.status, item.creatorDisplayName, item.content]
              .map((value) => value?.trim() ?? "")
              .filter(Boolean)
              .join(" · "),
          toInsertResult(item) {
            return createRichTextMentionInsertResult({
              entityId: item.issueId,
              href: buildWorkspaceIssueMentionHref({
                issueId: item.issueId,
                topicId: item.topicId,
                workspaceId: item.workspaceId
              }),
              kind: WORKSPACE_ISSUE_PROVIDER_ID,
              label: item.title,
              meta: {
                contentPreview: item.content?.trim() ?? "",
                creatorDisplayName: item.creatorDisplayName?.trim() ?? "",
                status: item.status?.trim() ?? "",
                topicId: item.topicId,
                workspaceId: item.workspaceId
              }
            });
          }
        }) as RichTextAtProvider<unknown>
      ];
    }
  };
}

function createAgentSessionAtContributor(
  tuttidClient: TuttidClient
): DesktopRichTextAtContributor {
  return {
    capability: "agent-session",
    getProviders(input) {
      return [
        createRichTextAtProvider<AgentSessionAtItem>({
          id: AGENT_SESSION_PROVIDER_ID,
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
            return createRichTextMentionInsertResult({
              entityId: item.id,
              href: buildMentionHref(AGENT_SESSION_PROVIDER_ID, {
                id: item.id,
                provider: item.provider?.trim() ?? "",
                workspaceId: item.workspaceId
              }),
              kind: AGENT_SESSION_PROVIDER_ID,
              label: resolveAgentSessionLabel(item),
              meta: {
                agentName: item.agentName?.trim() ?? "",
                initiatorName: item.initiatorName?.trim() ?? "",
                provider: item.provider?.trim() ?? "",
                scope: item.scope ?? "",
                sessionOrigin: item.sessionOrigin?.trim() ?? "",
                status: item.status?.trim() ?? "",
                title: resolveAgentSessionLabel(item),
                updatedAtUnixMs:
                  typeof item.updatedAtUnixMs === "number"
                    ? String(item.updatedAtUnixMs)
                    : "",
                userId: item.userId?.trim() ?? "",
                workspaceId: item.workspaceId
              }
            });
          }
        }) as RichTextAtProvider<unknown>
      ];
    }
  };
}

function buildMentionHref(
  resource:
    | typeof AGENT_SESSION_PROVIDER_ID
    | typeof WORKSPACE_APP_PROVIDER_ID
    | typeof WORKSPACE_ISSUE_PROVIDER_ID,
  params: {
    appId?: string;
    id?: string;
    provider?: string;
    topicId?: string;
    workspaceId: string;
  }
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const trimmed = value?.trim() ?? "";
    if (trimmed) {
      searchParams.set(key, trimmed);
    }
  }
  return `mention://${resource}?${searchParams.toString()}`;
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
  return currentUserId && currentUserId !== userId
    ? "collab_sessions"
    : "my_sessions";
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
