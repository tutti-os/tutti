import { resolveAgentMentionFileThumbnailUrl } from "../shared/mentionFilePresentation";
import { presentAgentGeneratedFileMentionItems } from "./agentMentionAgentGeneratedFilesPresentation";
import {
  AGENT_MENTION_FILTER_TAB_ORDER,
  buildEmptyGroup,
  compactText,
  filterForGroup,
  DEFAULT_MENTION_GROUP_PAGE_SIZE,
  groupIdsForFilter,
  mentionGroupPageSize,
  normalizeQuery,
  resolveMentionGroupItems,
  resolveMentionGroupTotalCount,
  shouldPrefetchBrowseFilter,
  shouldShowEmptyGroup
} from "./agentMentionSearchHelpers";
import { agentMentionFilterLabel } from "./AgentMentionLabels";
import type { AgentContextMentionItem } from "./agentRichText/agentFileMentionExtension";
import {
  buildAgentSessionMentionHref,
  buildAgentWorkspaceAppMentionHref,
  buildAgentWorkspaceIssueMentionHref,
  normalizeAgentSessionMentionTitle
} from "./agentRichText/agentFileMentionExtension";
import type {
  AgentRichTextAtInsertResult,
  AgentRichTextAtProvider
} from "./agentRichTextAtProvider";
import { AGENT_GUI_MENTION_PROVIDER_IDS } from "./agentRichTextAtProvider";
import type {
  MentionPaletteGroup,
  MentionPaletteState
} from "@tutti-os/ui-rich-text/at-panel";

export type AgentMentionFilterId = "all" | "app" | "file" | "session" | "issue";
export type AgentMentionGroupId =
  | "apps"
  | "files"
  | "opened_files"
  | "agent_generated_files"
  | "my_sessions"
  | "collab_sessions"
  | "issues";

type AgentMentionRawGroupId = Exclude<AgentMentionGroupId, "files">;

export interface AgentMentionBrowseCategory {
  id: AgentMentionFilterId;
  label: string;
}

export type AgentMentionGroup = MentionPaletteGroup<AgentContextMentionItem>;

export type AgentMentionSearchState =
  MentionPaletteState<AgentContextMentionItem>;

interface AgentMentionSearchControllerOptions {
  richTextAtProviders?: readonly AgentRichTextAtProvider[];
  debounceMs?: number;
  fileLimit?: number;
  issueLimit?: number;
  providerTimeoutMs?: number;
}

type Listener = (state: AgentMentionSearchState) => void;

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_FILE_LIMIT = 30;
const DEFAULT_ISSUE_LIMIT = 25;
const DEFAULT_SESSION_LIMIT = 30;
const DEFAULT_PROVIDER_TIMEOUT_MS = 3500;

// Resolve filter tab labels lazily so they reflect the active i18n locale at the
// time a state is emitted. Computing this at module load froze the labels to the
// default ("en") runtime, since the agent GUI i18n locale is only synced once the
// AgentGuiI18nProvider renders.
function buildBrowseCategories(): AgentMentionBrowseCategory[] {
  return AGENT_MENTION_FILTER_TAB_ORDER.map((id) => ({
    id,
    label: agentMentionFilterLabel(id)
  }));
}

const {
  agentGeneratedFile: AGENT_GENERATED_FILE_PROVIDER_ID,
  agentSession: AGENT_SESSION_PROVIDER_ID,
  file: FILE_PROVIDER_ID,
  workspaceApp: WORKSPACE_APP_PROVIDER_ID,
  workspaceIssue: WORKSPACE_ISSUE_PROVIDER_ID
} = AGENT_GUI_MENTION_PROVIDER_IDS;

export class AgentMentionSearchController {
  private readonly richTextAtProviders: ReadonlyMap<
    string,
    AgentRichTextAtProvider
  >;
  private readonly debounceMs: number;
  private readonly fileLimit: number;
  private readonly issueLimit: number;
  private readonly providerTimeoutMs: number;
  private readonly listeners = new Set<Listener>();
  private readonly expandedCounts: Partial<
    Record<AgentMentionGroupId, number>
  > = {};
  private readonly totalCounts: Partial<Record<AgentMentionGroupId, number>> =
    {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 0;
  private disposed = false;
  private activeWorkspaceId = "";
  private currentUserId = "";
  private currentFilter: AgentMentionFilterId = "all";
  private currentQuery = "";
  private currentSessionCwd = "";
  private currentFileSearchLimit: number;
  private currentIssueSearchLimit: number;
  private agentGeneratedBrowsePath: string | null = null;
  private rawGroups: Record<AgentMentionRawGroupId, AgentContextMentionItem[]> =
    {
      apps: [],
      opened_files: [],
      agent_generated_files: [],
      my_sessions: [],
      collab_sessions: [],
      issues: []
    };
  private state: AgentMentionSearchState = {
    status: "idle",
    query: "",
    mode: "browse",
    filter: "all",
    categories: buildBrowseCategories(),
    groups: [],
    error: null
  };

  constructor(options: AgentMentionSearchControllerOptions) {
    this.richTextAtProviders = new Map(
      (options.richTextAtProviders ?? []).map((provider) => [
        provider.id,
        provider
      ])
    );
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fileLimit = options.fileLimit ?? DEFAULT_FILE_LIMIT;
    this.issueLimit = options.issueLimit ?? DEFAULT_ISSUE_LIMIT;
    this.providerTimeoutMs =
      options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.currentFileSearchLimit = this.fileLimit;
    this.currentIssueSearchLimit = this.issueLimit;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  updateQuery(input: {
    workspaceId: string;
    currentUserId?: string | null;
    query: string;
    sessionCwd?: string | null;
  }): void {
    if (this.disposed) {
      return;
    }
    this.activeWorkspaceId = input.workspaceId.trim();
    this.currentUserId = input.currentUserId?.trim() ?? "";
    this.currentSessionCwd = input.sessionCwd?.trim() ?? "";
    this.currentQuery = normalizeQuery(input.query);
    this.clearTimer();
    const requestId = ++this.requestId;
    this.resetAgentGeneratedBrowsePath();
    this.resetExpandedCounts();
    this.resetSearchLimits();

    if (!this.activeWorkspaceId) {
      this.setState({
        status: "idle",
        query: this.currentQuery,
        mode: "browse",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: [],
        error: null
      });
      return;
    }

    if (!this.currentQuery) {
      this.startBrowseModeFetch(this.currentFilter);
      return;
    }

    this.setState({
      status: "loading",
      query: this.currentQuery,
      mode: "results",
      filter: this.currentFilter,
      categories: buildBrowseCategories(),
      groups: this.groupsFromRawGroups(),
      error: null
    });
    this.timer = setTimeout(() => {
      void this.runSearch({
        workspaceId: this.activeWorkspaceId,
        currentUserId: this.currentUserId,
        query: this.currentQuery,
        requestId
      });
    }, this.debounceMs);
  }

  setFilter(filter: AgentMentionFilterId): void {
    if (this.disposed) {
      return;
    }
    this.currentFilter = filter;
    this.resetAgentGeneratedBrowsePath();
    this.resetExpandedCounts();
    if (!this.currentQuery) {
      this.startBrowseModeFetch(filter);
      return;
    }
    this.setState({
      status: "ready",
      query: this.currentQuery,
      mode: "results",
      filter: this.currentFilter,
      categories: buildBrowseCategories(),
      groups: this.groupsFromRawGroups(),
      error: null
    });
  }

  enterCategory(category: Exclude<AgentMentionFilterId, "all">): void {
    if (this.disposed) {
      return;
    }
    this.currentFilter = category;
    this.resetExpandedCounts();
    this.clearTimer();
    if (!this.currentQuery) {
      this.startBrowseModeFetch(category);
      return;
    }
    if (!this.activeWorkspaceId) {
      this.emitBrowseState("ready");
      return;
    }
    const requestId = ++this.requestId;
    this.setState({
      status: "loading",
      query: this.currentQuery,
      mode: "results",
      filter: this.currentFilter,
      categories: buildBrowseCategories(),
      groups: this.groupsFromRawGroups(),
      error: null
    });
    void this.runSearch({
      workspaceId: this.activeWorkspaceId,
      currentUserId: this.currentUserId,
      query: this.currentQuery,
      requestId
    });
  }

  selectAgentGeneratedMentionItem(item: AgentContextMentionItem): boolean {
    if (item.kind !== "file" || !item.mentionNavigation) {
      return false;
    }
    if (item.mentionNavigation === "agent-generated-folder") {
      this.agentGeneratedBrowsePath = item.path;
      this.expandedCounts.agent_generated_files = mentionGroupPageSize(
        this.currentFilter,
        "agent_generated_files"
      );
      this.setState({
        status: this.state.status === "loading" ? "loading" : "ready",
        query: this.currentQuery,
        mode: this.currentQuery ? "results" : "browse",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: this.groupsFromRawGroups(),
        error: null
      });
      return true;
    }
    if (item.mentionNavigation === "agent-generated-folder-back") {
      this.resetAgentGeneratedBrowsePath();
      this.setState({
        status: this.state.status === "loading" ? "loading" : "ready",
        query: this.currentQuery,
        mode: this.currentQuery ? "results" : "browse",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: this.groupsFromRawGroups(),
        error: null
      });
      return true;
    }
    return false;
  }

  expandGroup(groupId: AgentMentionGroupId): void {
    const pageSize = mentionGroupPageSize(this.currentFilter, groupId);
    const current = this.expandedCounts[groupId] ?? pageSize;
    this.expandedCounts[groupId] = current + pageSize;
    if (!this.currentQuery) {
      const nextFilter = filterForGroup(groupId);
      if (this.currentFilter === "all") {
        this.currentFilter = nextFilter;
      }
      this.setState({
        status: "ready",
        query: "",
        mode: "browse",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: this.groupsFromRawGroups(),
        error: null
      });
      return;
    }
    const needsMoreFiles =
      (groupId === "opened_files" ||
        groupId === "files" ||
        groupId === "agent_generated_files") &&
      (groupId === "agent_generated_files"
        ? this.rawGroups.agent_generated_files.length >=
          this.currentFileSearchLimit
        : this.rawGroups.opened_files.length >= this.currentFileSearchLimit);
    const needsMoreIssues =
      groupId === "issues" &&
      (this.totalCounts.issues ?? this.rawGroups.issues.length) >
        this.rawGroups.issues.length;
    if (needsMoreFiles) {
      this.currentFileSearchLimit += DEFAULT_MENTION_GROUP_PAGE_SIZE;
    }
    if (needsMoreIssues) {
      this.currentIssueSearchLimit += DEFAULT_MENTION_GROUP_PAGE_SIZE;
    }
    if (needsMoreFiles || needsMoreIssues) {
      this.clearTimer();
      const requestId = ++this.requestId;
      this.setState({
        status: "loading",
        query: this.currentQuery,
        mode: "results",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: this.groupsFromRawGroups(),
        error: null
      });
      void this.runSearch({
        workspaceId: this.activeWorkspaceId,
        currentUserId: this.currentUserId,
        query: this.currentQuery,
        requestId
      });
      return;
    }
    this.setState({
      status: "ready",
      query: this.currentQuery,
      mode: "results",
      filter: this.currentFilter,
      categories: buildBrowseCategories(),
      groups: this.groupsFromRawGroups(),
      error: null
    });
  }

  close(): void {
    this.clearTimer();
    this.requestId += 1;
    this.currentFilter = "all";
    this.resetAgentGeneratedBrowsePath();
    this.resetExpandedCounts();
    this.resetSearchLimits();
    this.rawGroups = {
      apps: [],
      opened_files: [],
      agent_generated_files: [],
      my_sessions: [],
      collab_sessions: [],
      issues: []
    };
    this.totalCounts.apps = 0;
    this.totalCounts.opened_files = 0;
    this.totalCounts.agent_generated_files = 0;
    this.totalCounts.my_sessions = 0;
    this.totalCounts.collab_sessions = 0;
    this.totalCounts.issues = 0;
    this.currentQuery = "";
    this.setState({
      status: "idle",
      query: "",
      mode: "browse",
      filter: "all",
      categories: buildBrowseCategories(),
      groups: [],
      error: null
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.listeners.clear();
    this.requestId += 1;
  }

  private startBrowseModeFetch(filter: AgentMentionFilterId): void {
    if (!this.activeWorkspaceId || !shouldPrefetchBrowseFilter(filter)) {
      this.rawGroups = {
        apps: [],
        opened_files: [],
        agent_generated_files: [],
        my_sessions: [],
        collab_sessions: [],
        issues: []
      };
      this.emitBrowseState("ready");
      return;
    }
    this.clearTimer();
    const requestId = ++this.requestId;
    this.rawGroups = {
      apps: [],
      opened_files: [],
      agent_generated_files: [],
      my_sessions: [],
      collab_sessions: [],
      issues: []
    };
    this.emitBrowseState("loading");
    void this.runBrowseSearch({
      workspaceId: this.activeWorkspaceId,
      currentUserId: this.currentUserId,
      requestId,
      filter
    });
  }

  private async runSearch(input: {
    workspaceId: string;
    currentUserId: string;
    query: string;
    requestId: number;
  }): Promise<void> {
    try {
      const [fileItems, appItems, issueItems, sessionItems] = await Promise.all(
        [
          this.queryProviderMentionItemsById({
            providerId: FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: input.query,
            limit: this.currentFileSearchLimit
          }),
          this.queryProviderMentionItemsById({
            providerId: WORKSPACE_APP_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: input.query,
            limit: DEFAULT_MENTION_GROUP_PAGE_SIZE
          }),
          this.queryProviderMentionItemsById({
            providerId: WORKSPACE_ISSUE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: input.query,
            limit: this.currentIssueSearchLimit
          }),
          this.queryProviderMentionItemsById({
            providerId: AGENT_SESSION_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: input.query,
            limit: DEFAULT_SESSION_LIMIT
          })
        ]
      );

      if (!this.canApply(input.requestId, input.workspaceId, input.query)) {
        return;
      }

      this.rawGroups = {
        apps: appItems.filter((item) => item.kind === "workspace-app"),
        opened_files: fileItems.filter((item) => item.kind === "file"),
        agent_generated_files: [],
        my_sessions: sessionItems.filter(
          (item) => item.kind === "session" && item.scope === "my_sessions"
        ),
        collab_sessions: sessionItems.filter(
          (item) => item.kind === "session" && item.scope === "collab_sessions"
        ),
        issues: issueItems.filter((item) => item.kind === "workspace-issue")
      };
      this.totalCounts.apps = this.rawGroups.apps.length;
      this.totalCounts.opened_files = this.rawGroups.opened_files.length;
      this.totalCounts.agent_generated_files = 0;
      this.totalCounts.my_sessions = this.rawGroups.my_sessions.length;
      this.totalCounts.collab_sessions = this.rawGroups.collab_sessions.length;
      this.totalCounts.issues = this.rawGroups.issues.length;

      this.setState({
        status: "ready",
        query: input.query,
        mode: "results",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: this.groupsFromRawGroups(),
        error: null
      });
    } catch (error) {
      if (!this.canApply(input.requestId, input.workspaceId, input.query)) {
        return;
      }
      this.setState({
        status: "error",
        query: input.query,
        mode: "results",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: [],
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async runBrowseSearch(input: {
    workspaceId: string;
    currentUserId: string;
    requestId: number;
    filter: AgentMentionFilterId;
  }): Promise<void> {
    try {
      if (input.filter === "file") {
        const [fileItems, agentGeneratedFileItems] = await Promise.all([
          this.queryProviderMentionItemsById({
            providerId: FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.fileLimit
          }),
          this.queryProviderMentionItemsById({
            providerId: AGENT_GENERATED_FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.fileLimit
          })
        ]);
        if (!this.canApply(input.requestId, input.workspaceId, "")) {
          return;
        }
        this.rawGroups = {
          apps: [],
          opened_files: fileItems.filter((item) => item.kind === "file"),
          agent_generated_files: agentGeneratedFileItems.filter(
            (item) => item.kind === "file"
          ),
          my_sessions: [],
          collab_sessions: [],
          issues: []
        };
        this.totalCounts.apps = 0;
        this.totalCounts.opened_files = this.rawGroups.opened_files.length;
        this.totalCounts.agent_generated_files =
          this.rawGroups.agent_generated_files.length;
        this.totalCounts.my_sessions = 0;
        this.totalCounts.collab_sessions = 0;
        this.totalCounts.issues = 0;
      } else if (input.filter === "app") {
        const appItems = await this.queryProviderMentionItemsById({
          providerId: WORKSPACE_APP_PROVIDER_ID,
          workspaceId: input.workspaceId,
          currentUserId: input.currentUserId,
          query: "",
          limit: DEFAULT_MENTION_GROUP_PAGE_SIZE
        });
        if (!this.canApply(input.requestId, input.workspaceId, "")) {
          return;
        }
        this.rawGroups = {
          apps: appItems.filter((item) => item.kind === "workspace-app"),
          opened_files: [],
          agent_generated_files: [],
          my_sessions: [],
          collab_sessions: [],
          issues: []
        };
        this.totalCounts.apps = this.rawGroups.apps.length;
        this.totalCounts.opened_files = 0;
        this.totalCounts.agent_generated_files = 0;
        this.totalCounts.my_sessions = 0;
        this.totalCounts.collab_sessions = 0;
        this.totalCounts.issues = 0;
      } else if (input.filter === "issue") {
        const issueItems = await this.queryProviderMentionItemsById({
          providerId: WORKSPACE_ISSUE_PROVIDER_ID,
          workspaceId: input.workspaceId,
          currentUserId: input.currentUserId,
          query: "",
          limit: this.currentIssueSearchLimit
        });
        if (!this.canApply(input.requestId, input.workspaceId, "")) {
          return;
        }
        this.rawGroups = {
          apps: [],
          opened_files: [],
          agent_generated_files: [],
          my_sessions: [],
          collab_sessions: [],
          issues: issueItems.filter((item) => item.kind === "workspace-issue")
        };
        this.totalCounts.apps = 0;
        this.totalCounts.opened_files = 0;
        this.totalCounts.agent_generated_files = 0;
        this.totalCounts.my_sessions = 0;
        this.totalCounts.collab_sessions = 0;
        this.totalCounts.issues = this.rawGroups.issues.length;
      } else if (input.filter === "session") {
        const sessionItems = await this.queryProviderMentionItemsById({
          providerId: AGENT_SESSION_PROVIDER_ID,
          workspaceId: input.workspaceId,
          currentUserId: input.currentUserId,
          query: "",
          limit: DEFAULT_SESSION_LIMIT
        });
        if (!this.canApply(input.requestId, input.workspaceId, "")) {
          return;
        }
        const sessionMentionItems = sessionItems.filter(
          (item) => item.kind === "session"
        );
        const mySessionItems = sessionMentionItems
          .filter((item) =>
            input.currentUserId ? item.scope === "my_sessions" : true
          )
          .map((item) =>
            item.scope === "my_sessions"
              ? item
              : { ...item, scope: "my_sessions" as const }
          );
        this.rawGroups = {
          apps: [],
          opened_files: [],
          agent_generated_files: [],
          my_sessions: mySessionItems,
          collab_sessions: [],
          issues: []
        };
        this.totalCounts.apps = 0;
        this.totalCounts.opened_files = 0;
        this.totalCounts.agent_generated_files = 0;
        this.totalCounts.my_sessions = this.rawGroups.my_sessions.length;
        this.totalCounts.collab_sessions =
          this.rawGroups.collab_sessions.length;
        this.totalCounts.issues = 0;
      } else {
        const [
          appItems,
          fileItems,
          agentGeneratedFileItems,
          issueItems,
          sessionItems
        ] = await Promise.all([
          this.queryProviderMentionItemsById({
            providerId: WORKSPACE_APP_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: DEFAULT_MENTION_GROUP_PAGE_SIZE
          }),
          this.queryProviderMentionItemsById({
            providerId: FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.fileLimit
          }),
          this.queryProviderMentionItemsById({
            providerId: AGENT_GENERATED_FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.fileLimit
          }),
          this.queryProviderMentionItemsById({
            providerId: WORKSPACE_ISSUE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.currentIssueSearchLimit
          }),
          this.queryProviderMentionItemsById({
            providerId: AGENT_SESSION_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: DEFAULT_SESSION_LIMIT
          })
        ]);
        if (!this.canApply(input.requestId, input.workspaceId, "")) {
          return;
        }
        this.rawGroups = {
          apps: appItems.filter((item) => item.kind === "workspace-app"),
          opened_files: fileItems.filter((item) => item.kind === "file"),
          agent_generated_files: agentGeneratedFileItems.filter(
            (item) => item.kind === "file"
          ),
          my_sessions: sessionItems.filter(
            (item) => item.kind === "session" && item.scope === "my_sessions"
          ),
          collab_sessions: sessionItems.filter(
            (item) =>
              item.kind === "session" && item.scope === "collab_sessions"
          ),
          issues: issueItems.filter((item) => item.kind === "workspace-issue")
        };
        this.totalCounts.apps = this.rawGroups.apps.length;
        this.totalCounts.opened_files = this.rawGroups.opened_files.length;
        this.totalCounts.agent_generated_files =
          this.rawGroups.agent_generated_files.length;
        this.totalCounts.my_sessions = this.rawGroups.my_sessions.length;
        this.totalCounts.collab_sessions =
          this.rawGroups.collab_sessions.length;
        this.totalCounts.issues = this.rawGroups.issues.length;
      }

      this.setState({
        status: "ready",
        query: "",
        mode: "browse",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: this.groupsFromRawGroups(),
        error: null
      });
    } catch (error) {
      if (!this.canApply(input.requestId, input.workspaceId, "")) {
        return;
      }
      this.setState({
        status: "error",
        query: "",
        mode: "browse",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: [],
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async queryProviderMentionItems(input: {
    provider: AgentRichTextAtProvider;
    workspaceId: string;
    currentUserId: string;
    query: string;
    limit: number;
    abortSignal: AbortSignal;
  }): Promise<AgentContextMentionItem[]> {
    const items = await input.provider.query({
      keyword: input.query,
      maxResults: input.limit,
      abortSignal: input.abortSignal,
      context: {
        metadata: {
          currentUserId: input.currentUserId,
          sessionCwd: this.currentSessionCwd || undefined,
          target: "agent-gui",
          workspaceId: input.workspaceId
        }
      }
    });
    if (input.abortSignal.aborted) {
      return [];
    }
    const mentionItems = await Promise.all(
      items.map(async (item) => {
        const mentionItem = providerItemToAgentMentionItem({
          currentUserId: input.currentUserId,
          insertResult: input.provider.toInsertResult(item),
          label: input.provider.getItemLabel(item),
          providerId: input.provider.id,
          subtitle: input.provider.getItemSubtitle?.(item) ?? "",
          workspaceId: input.workspaceId
        });
        if (!mentionItem || mentionItem.kind !== "file") {
          return mentionItem;
        }
        const thumbnailUrl = await Promise.resolve(
          input.provider.getItemThumbnailUrl?.(item) ?? null
        ).catch(() => null);
        const resolvedThumbnailUrl = resolveAgentMentionFileThumbnailUrl({
          ...mentionItem,
          thumbnailUrl
        });
        if (!resolvedThumbnailUrl) {
          return mentionItem;
        }
        return {
          ...mentionItem,
          thumbnailUrl: resolvedThumbnailUrl
        };
      })
    );
    return mentionItems.filter(
      (item): item is AgentContextMentionItem => item !== null
    );
  }

  private async queryProviderMentionItemsById(input: {
    providerId: string;
    workspaceId: string;
    currentUserId: string;
    query: string;
    limit: number;
  }): Promise<AgentContextMentionItem[]> {
    const provider = this.richTextAtProviders.get(input.providerId);
    if (!provider) {
      return [];
    }
    return this.runProviderQuery(
      (abortSignal) =>
        this.queryProviderMentionItems({
          provider,
          workspaceId: input.workspaceId,
          currentUserId: input.currentUserId,
          query: input.query,
          limit: input.limit,
          abortSignal
        }),
      []
    );
  }

  private async runProviderQuery<T>(
    query: (abortSignal: AbortSignal) => Promise<T>,
    fallback: T
  ): Promise<T> {
    const abortController = new AbortController();
    const queryPromise = Promise.resolve().then(() =>
      query(abortController.signal)
    );

    if (
      this.providerTimeoutMs <= 0 ||
      !Number.isFinite(this.providerTimeoutMs)
    ) {
      return queryPromise;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<T>((resolve) => {
      timeout = setTimeout(() => {
        abortController.abort();
        resolve(fallback);
      }, this.providerTimeoutMs);
    });

    try {
      return await Promise.race([queryPromise, timeoutPromise]);
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    }
  }

  private groupsFromRawGroups(): AgentMentionGroup[] {
    const orderedGroupIds = groupIdsForFilter(this.currentFilter);
    const groups = orderedGroupIds
      .map((groupId) => {
        const rawItems = resolveMentionGroupItems(groupId, this.rawGroups);
        const items =
          groupId === "agent_generated_files"
            ? presentAgentGeneratedFileMentionItems({
                files: rawItems,
                browsePath: this.agentGeneratedBrowsePath,
                query: this.currentQuery
              })
            : rawItems;
        if (items.length === 0) {
          if (
            !shouldShowEmptyGroup(
              groupId,
              this.currentFilter,
              this.currentQuery
            )
          ) {
            return null;
          }
          return buildEmptyGroup(groupId, this.currentQuery);
        }
        const pageSize = mentionGroupPageSize(this.currentFilter, groupId);
        const visibleCount = Math.min(
          items.length,
          this.expandedCounts[groupId] ?? pageSize
        );
        const totalCount = resolveMentionGroupTotalCount(
          groupId,
          this.totalCounts,
          items.length
        );
        return {
          id: groupId,
          items: items.slice(0, visibleCount),
          totalCount,
          visibleCount,
          hasMore:
            items.length > visibleCount ||
            ((groupId === "opened_files" ||
              groupId === "files" ||
              groupId === "agent_generated_files") &&
              items.length >= this.currentFileSearchLimit) ||
            totalCount > visibleCount
        } satisfies AgentMentionGroup;
      })
      .filter((group): group is AgentMentionGroup => group !== null);
    return orderMentionGroupsForFilter({
      filter: this.currentFilter,
      groups,
      query: this.currentQuery
    });
  }

  private emitBrowseState(status: "ready" | "loading"): void {
    this.setState({
      status,
      query: "",
      mode: "browse",
      filter: this.currentFilter,
      categories: buildBrowseCategories(),
      groups: [],
      error: null
    });
  }

  private canApply(
    requestId: number,
    workspaceId: string,
    query: string
  ): boolean {
    return (
      !this.disposed &&
      requestId === this.requestId &&
      workspaceId === this.activeWorkspaceId &&
      query === this.currentQuery
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private resetExpandedCounts(): void {
    for (const groupId of [
      "files",
      "opened_files",
      "agent_generated_files",
      "my_sessions",
      "collab_sessions",
      "apps",
      "issues"
    ] as const) {
      this.expandedCounts[groupId] = mentionGroupPageSize(
        this.currentFilter,
        groupId
      );
    }
  }

  private resetSearchLimits(): void {
    this.currentFileSearchLimit = this.fileLimit;
    this.currentIssueSearchLimit = this.issueLimit;
  }

  private resetAgentGeneratedBrowsePath(): void {
    this.agentGeneratedBrowsePath = null;
  }

  private setState(state: AgentMentionSearchState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function orderMentionGroupsForFilter(input: {
  filter: AgentMentionFilterId;
  groups: AgentMentionGroup[];
  query: string;
}): AgentMentionGroup[] {
  if (input.filter !== "all") {
    return input.groups;
  }
  const query = normalizeQuery(input.query).toLowerCase();
  return input.groups
    .map((group, index) => ({
      group,
      hasItems: group.items.length > 0,
      index,
      score: mentionGroupBestMatchScore(group, query)
    }))
    .sort((left, right) => {
      if (left.hasItems !== right.hasItems) {
        return left.hasItems ? -1 : 1;
      }
      if (query && left.score !== right.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.group);
}

function mentionGroupBestMatchScore(
  group: AgentMentionGroup,
  query: string
): number {
  if (!query) {
    return 0;
  }
  return group.items.reduce(
    (bestScore, item) =>
      Math.max(bestScore, mentionItemMatchScore(item, query)),
    0
  );
}

function mentionItemMatchScore(
  item: AgentContextMentionItem,
  query: string
): number {
  const primary: string[] = [];
  const secondary: string[] = [];
  let kindBoost = 0;

  if (item.kind === "workspace-app") {
    kindBoost = 8;
    primary.push(item.name, item.appId, item.targetId);
    secondary.push(item.description ?? "");
  } else if (item.kind === "file") {
    primary.push(item.name);
    secondary.push(item.path, item.directoryPath);
  } else if (item.kind === "session") {
    primary.push(item.title);
    secondary.push(
      item.name,
      item.initiatorName,
      item.agentName,
      item.inputPreview ?? "",
      item.summaryPreview ?? ""
    );
  } else if (item.kind === "workspace-issue") {
    primary.push(item.title, item.name);
    secondary.push(
      item.creatorName ?? "",
      item.status ?? "",
      item.contentPreview ?? ""
    );
  } else if (item.kind === "workspace-app-factory") {
    primary.push(item.name, item.jobId, item.targetId);
    secondary.push(item.action ?? "", item.contextPath ?? "");
  }

  const primaryScore = maxTextMatchScore(primary, query, {
    contains: 60,
    exact: 100,
    prefix: 90,
    wordPrefix: 80
  });
  const secondaryScore = maxTextMatchScore(secondary, query, {
    contains: 25,
    exact: 60,
    prefix: 50,
    wordPrefix: 40
  });
  const score = Math.max(primaryScore, secondaryScore);
  return score > 0 ? score + kindBoost : 0;
}

function maxTextMatchScore(
  values: readonly string[],
  query: string,
  scores: {
    contains: number;
    exact: number;
    prefix: number;
    wordPrefix: number;
  }
): number {
  return values.reduce(
    (bestScore, value) =>
      Math.max(bestScore, textMatchScore(value, query, scores)),
    0
  );
}

function textMatchScore(
  value: string,
  query: string,
  scores: {
    contains: number;
    exact: number;
    prefix: number;
    wordPrefix: number;
  }
): number {
  const normalized = normalizeQuery(value).toLowerCase();
  if (!normalized) {
    return 0;
  }
  if (normalized === query) {
    return scores.exact;
  }
  if (normalized.startsWith(query)) {
    return scores.prefix;
  }
  if (normalized.split(/[^a-z0-9]+/i).some((word) => word.startsWith(query))) {
    return scores.wordPrefix;
  }
  return normalized.includes(query) ? scores.contains : 0;
}

function providerItemToAgentMentionItem(input: {
  currentUserId: string;
  providerId: string;
  insertResult: AgentRichTextAtInsertResult;
  label: string;
  subtitle: string;
  workspaceId: string;
}): AgentContextMentionItem | null {
  const label = compactText(input.label);
  if (!label) {
    return null;
  }
  if (input.insertResult.kind === "markdown-link") {
    const href = input.insertResult.href.trim();
    return {
      kind: "file",
      href,
      path: href,
      name: label,
      entryKind: href.endsWith("/") ? "directory" : "unknown",
      directoryPath: dirnameFromProviderWorkspaceFileHref(href)
    };
  }
  if (input.insertResult.kind !== "mention") {
    return null;
  }

  const mention = input.insertResult.mention;
  const targetId = mention.entityId.trim();
  if (!targetId) {
    return null;
  }
  const kind = mention.kind?.trim() || input.providerId;
  const workspaceId = mention.meta?.workspaceId?.trim() || input.workspaceId;
  if (kind === WORKSPACE_ISSUE_PROVIDER_ID) {
    return {
      kind: "workspace-issue",
      href:
        mention.href?.trim() ||
        buildAgentWorkspaceIssueMentionHref(workspaceId, targetId),
      workspaceId,
      targetId,
      name: label,
      title: label,
      status: mention.meta?.status?.trim() || undefined,
      contentPreview:
        compactText(mention.meta?.contentPreview) ||
        compactText(input.subtitle) ||
        undefined
    };
  }
  if (kind === WORKSPACE_APP_PROVIDER_ID) {
    const appId = mention.meta?.appId?.trim() || targetId;
    return {
      kind: "workspace-app",
      href:
        mention.href?.trim() ||
        buildAgentWorkspaceAppMentionHref(workspaceId, appId),
      workspaceId,
      targetId: appId,
      appId,
      name: label,
      description:
        compactText(mention.meta?.description) ||
        compactText(input.subtitle) ||
        undefined,
      iconUrl: mention.meta?.iconUrl?.trim() || undefined
    };
  }
  if (kind === AGENT_SESSION_PROVIDER_ID || kind === "session") {
    const provider = mention.meta?.provider?.trim() || "";
    const agentName = mention.meta?.agentName?.trim() || provider;
    const userId = mention.meta?.userId?.trim() || "";
    const initiatorName = normalizeSessionInitiatorDisplayName(
      mention.meta?.initiatorName?.trim() || userId
    );
    const initiatorAvatarUrl = mention.meta?.initiatorAvatarUrl?.trim() || "";
    const scope = mentionSessionScope({
      currentUserId: input.currentUserId,
      rawScope: mention.meta?.scope,
      userId
    });
    const title =
      normalizeAgentSessionMentionTitle(mention.meta?.title?.trim() || label) ||
      label;
    const inputPreview = mention.meta?.inputPreview?.trim() || "";
    const summaryPreview =
      mention.meta?.summaryPreview?.trim() ||
      compactText(input.subtitle) ||
      undefined;
    const updatedAtUnixMs = numberFromString(mention.meta?.updatedAtUnixMs);
    return {
      kind: "session",
      href:
        mention.href?.trim() ||
        buildAgentSessionMentionHref(workspaceId, targetId, provider),
      workspaceId,
      targetId,
      name:
        initiatorName || agentName
          ? `${initiatorName}${
              initiatorName && agentName ? " & " : ""
            }${agentName} ${title}`.trim()
          : label,
      title,
      scope,
      initiatorName,
      ...(initiatorAvatarUrl ? { initiatorAvatarUrl } : {}),
      agentName,
      status: mention.meta?.status?.trim() || undefined,
      inputPreview: inputPreview || undefined,
      summaryPreview,
      updatedAtUnixMs: updatedAtUnixMs ?? undefined
    };
  }
  return null;
}

function normalizeSessionInitiatorDisplayName(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase() === "local" ? "User" : trimmed;
}

function mentionSessionScope(input: {
  currentUserId: string;
  rawScope: string | undefined;
  userId: string;
}): Extract<AgentContextMentionItem, { kind: "session" }>["scope"] {
  const rawScope = input.rawScope?.trim() ?? "";
  if (rawScope === "my_sessions" || rawScope === "collab_sessions") {
    return rawScope;
  }
  return input.userId && input.userId === input.currentUserId
    ? "my_sessions"
    : "collab_sessions";
}

function numberFromString(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function dirnameFromProviderWorkspaceFileHref(href: string): string {
  const normalized = href.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}
