import { resolveAgentMentionFileThumbnailUrl } from "../shared/mentionFilePresentation";
import { presentAgentGeneratedFileMentionItems } from "./agentMentionAgentGeneratedFilesPresentation";
import {
  emitAgentMentionSearchDiagnostic,
  logAgentMentionSearchInfo,
  queryAgentMentionProviderWithDiagnostics,
  type AgentMentionProviderQueryDiagnostic,
  type AgentMentionSearchDiagnosticLog
} from "./agentMentionSearchDiagnostics";
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
  buildAgentGenericMentionHref,
  buildAgentSessionMentionHref,
  buildAgentWorkspaceAppMentionHref,
  buildAgentWorkspaceIssueMentionHref,
  normalizeAgentSessionMentionTitle
} from "./agentRichText/agentFileMentionExtension";
import type {
  AgentContextMentionInsertResult,
  AgentContextMentionProvider
} from "./agentContextMentionProvider";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "./agentContextMentionProvider";
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
  contextMentionProviders?: readonly AgentContextMentionProvider[];
  debounceMs?: number;
  fileLimit?: number;
  issueLimit?: number;
  providerTimeoutMs?: number;
  diagnosticInfoLogger?: (payload: AgentMentionSearchDiagnosticLog) => void;
  diagnosticNow?: () => number;
  diagnosticSlowThresholdMs?: number;
}

type Listener = (state: AgentMentionSearchState) => void;

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_FILE_LIMIT = 30;
const DEFAULT_ISSUE_LIMIT = 25;
const DEFAULT_SESSION_LIMIT = 30;
const DEFAULT_PROVIDER_TIMEOUT_MS = 3500;
const DEFAULT_DIAGNOSTIC_SLOW_THRESHOLD_MS = 250;

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
} = AGENT_CONTEXT_MENTION_PROVIDER_IDS;

export class AgentMentionSearchController {
  private readonly contextMentionProviders: ReadonlyMap<
    string,
    AgentContextMentionProvider
  >;
  private readonly debounceMs: number;
  private readonly fileLimit: number;
  private readonly issueLimit: number;
  private readonly providerTimeoutMs: number;
  private readonly diagnosticInfoLogger: (
    payload: AgentMentionSearchDiagnosticLog
  ) => void;
  private readonly diagnosticNow: () => number;
  private readonly diagnosticSlowThresholdMs: number;
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
    this.contextMentionProviders = new Map(
      (options.contextMentionProviders ?? []).map((provider) => [
        provider.id,
        provider
      ])
    );
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fileLimit = options.fileLimit ?? DEFAULT_FILE_LIMIT;
    this.issueLimit = options.issueLimit ?? DEFAULT_ISSUE_LIMIT;
    this.providerTimeoutMs =
      options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.diagnosticInfoLogger =
      options.diagnosticInfoLogger ?? logAgentMentionSearchInfo;
    this.diagnosticNow = options.diagnosticNow ?? Date.now;
    this.diagnosticSlowThresholdMs =
      options.diagnosticSlowThresholdMs ?? DEFAULT_DIAGNOSTIC_SLOW_THRESHOLD_MS;
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
    const startedAt = this.diagnosticNow();
    const providerDiagnostics: AgentMentionProviderQueryDiagnostic[] = [];
    try {
      const [fileItems, appItems, issueItems, sessionItems] = await Promise.all(
        [
          this.queryProviderMentionItemsById({
            providerId: FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: input.query,
            limit: this.currentFileSearchLimit,
            diagnostics: providerDiagnostics
          }),
          this.queryProviderMentionItemsById({
            providerId: WORKSPACE_APP_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: input.query,
            limit: DEFAULT_MENTION_GROUP_PAGE_SIZE,
            diagnostics: providerDiagnostics
          }),
          this.queryProviderMentionItemsById({
            providerId: WORKSPACE_ISSUE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: input.query,
            limit: this.currentIssueSearchLimit,
            diagnostics: providerDiagnostics
          }),
          this.queryProviderMentionItemsById({
            providerId: AGENT_SESSION_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: input.query,
            limit: DEFAULT_SESSION_LIMIT,
            diagnostics: providerDiagnostics
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
      const groups = this.groupsFromRawGroups();

      this.setState({
        status: "ready",
        query: input.query,
        mode: "results",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups,
        error: null
      });
      this.logSearchDiagnostic({
        filter: this.currentFilter,
        groups,
        mode: "results",
        providerDiagnostics,
        query: input.query,
        requestId: input.requestId,
        startedAt,
        status: "ready",
        workspaceId: input.workspaceId
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
      this.logSearchDiagnostic({
        error,
        filter: this.currentFilter,
        groups: [],
        mode: "results",
        providerDiagnostics,
        query: input.query,
        requestId: input.requestId,
        startedAt,
        status: "error",
        workspaceId: input.workspaceId
      });
    }
  }

  private async runBrowseSearch(input: {
    workspaceId: string;
    currentUserId: string;
    requestId: number;
    filter: AgentMentionFilterId;
  }): Promise<void> {
    const startedAt = this.diagnosticNow();
    const providerDiagnostics: AgentMentionProviderQueryDiagnostic[] = [];
    try {
      if (input.filter === "file") {
        const [fileItems, agentGeneratedFileItems] = await Promise.all([
          this.queryProviderMentionItemsById({
            providerId: FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.fileLimit,
            diagnostics: providerDiagnostics
          }),
          this.queryProviderMentionItemsById({
            providerId: AGENT_GENERATED_FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.fileLimit,
            diagnostics: providerDiagnostics
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
          limit: DEFAULT_MENTION_GROUP_PAGE_SIZE,
          diagnostics: providerDiagnostics
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
          limit: this.currentIssueSearchLimit,
          diagnostics: providerDiagnostics
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
          limit: DEFAULT_SESSION_LIMIT,
          diagnostics: providerDiagnostics
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
            limit: DEFAULT_MENTION_GROUP_PAGE_SIZE,
            diagnostics: providerDiagnostics
          }),
          this.queryProviderMentionItemsById({
            providerId: FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.fileLimit,
            diagnostics: providerDiagnostics
          }),
          this.queryProviderMentionItemsById({
            providerId: AGENT_GENERATED_FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.fileLimit,
            diagnostics: providerDiagnostics
          }),
          this.queryProviderMentionItemsById({
            providerId: WORKSPACE_ISSUE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: this.currentIssueSearchLimit,
            diagnostics: providerDiagnostics
          }),
          this.queryProviderMentionItemsById({
            providerId: AGENT_SESSION_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: "",
            limit: DEFAULT_SESSION_LIMIT,
            diagnostics: providerDiagnostics
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
      const groups = this.groupsFromRawGroups();

      this.setState({
        status: "ready",
        query: "",
        mode: "browse",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups,
        error: null
      });
      this.logSearchDiagnostic({
        filter: this.currentFilter,
        groups,
        mode: "browse",
        providerDiagnostics,
        query: "",
        requestId: input.requestId,
        startedAt,
        status: "ready",
        workspaceId: input.workspaceId
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
      this.logSearchDiagnostic({
        error,
        filter: this.currentFilter,
        groups: [],
        mode: "browse",
        providerDiagnostics,
        query: "",
        requestId: input.requestId,
        startedAt,
        status: "error",
        workspaceId: input.workspaceId
      });
    }
  }

  private async queryProviderMentionItems(input: {
    provider: AgentContextMentionProvider;
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
      trigger: "@",
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
        const iconUrl = await Promise.resolve(
          input.provider.getItemIconUrl?.(item) ?? null
        ).catch(() => null);
        const resolvedThumbnailUrl = resolveAgentMentionFileThumbnailUrl({
          ...mentionItem,
          thumbnailUrl: iconUrl
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
    diagnostics: AgentMentionProviderQueryDiagnostic[];
    providerId: string;
    workspaceId: string;
    currentUserId: string;
    query: string;
    limit: number;
  }): Promise<AgentContextMentionItem[]> {
    const provider = this.contextMentionProviders.get(input.providerId);
    return queryAgentMentionProviderWithDiagnostics({
      diagnosticNow: this.diagnosticNow,
      diagnostics: input.diagnostics,
      fallback: [] as AgentContextMentionItem[],
      providerId: input.providerId,
      providerTimeoutMs: this.providerTimeoutMs,
      query: provider
        ? (abortSignal) =>
            this.queryProviderMentionItems({
              provider,
              workspaceId: input.workspaceId,
              currentUserId: input.currentUserId,
              query: input.query,
              limit: input.limit,
              abortSignal
            })
        : null,
      resultCount: (result) => result.length
    });
  }

  private logSearchDiagnostic(input: {
    error?: unknown;
    filter: AgentMentionFilterId;
    groups: readonly AgentMentionGroup[];
    mode: "browse" | "results";
    providerDiagnostics: readonly AgentMentionProviderQueryDiagnostic[];
    query: string;
    requestId: number;
    startedAt: number;
    status: "ready" | "error";
    workspaceId: string;
  }): void {
    emitAgentMentionSearchDiagnostic({
      debounceMs: this.debounceMs,
      diagnosticInfoLogger: this.diagnosticInfoLogger,
      diagnosticNow: this.diagnosticNow,
      diagnosticSlowThresholdMs: this.diagnosticSlowThresholdMs,
      error: input.error,
      filter: input.filter,
      groups: input.groups,
      mode: input.mode,
      providerDiagnostics: input.providerDiagnostics,
      providerTimeoutMs: this.providerTimeoutMs,
      query: input.query,
      requestId: input.requestId,
      startedAt: input.startedAt,
      status: input.status,
      workspaceId: input.workspaceId
    });
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
  insertResult: AgentContextMentionInsertResult;
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
  const scope = normalizeMentionScope(mention.scope);
  const presentation = mention.presentation ?? {};
  const workspaceId = scope.workspaceId || input.workspaceId;
  if (
    input.providerId === FILE_PROVIDER_ID ||
    input.providerId === AGENT_GENERATED_FILE_PROVIDER_ID
  ) {
    return {
      kind: "file",
      href: buildAgentGenericMentionHref(input.providerId, targetId, scope),
      path: targetId,
      name: label,
      entryKind: targetId.endsWith("/") ? "directory" : "unknown",
      directoryPath: dirnameFromProviderWorkspaceFileHref(targetId),
      thumbnailUrl: presentation.thumbnailUrl?.trim() || undefined
    };
  }
  if (input.providerId === WORKSPACE_ISSUE_PROVIDER_ID) {
    return {
      kind: "workspace-issue",
      href: buildAgentWorkspaceIssueMentionHref(workspaceId, targetId, {
        topicId: scope.topicId
      }),
      workspaceId,
      targetId,
      topicId: scope.topicId,
      name: label,
      title: label,
      status: presentation.status?.trim() || undefined,
      contentPreview:
        compactText(presentation.description) ||
        compactText(input.subtitle) ||
        undefined
    };
  }
  if (input.providerId === WORKSPACE_APP_PROVIDER_ID) {
    const appId = targetId;
    return {
      kind: "workspace-app",
      href: buildAgentWorkspaceAppMentionHref(workspaceId, appId),
      workspaceId,
      targetId: appId,
      appId,
      name: label,
      description:
        compactText(presentation.description) ||
        compactText(presentation.subtitle) ||
        compactText(input.subtitle) ||
        undefined,
      iconUrl: presentation.iconUrl?.trim() || undefined,
      referencesListSupported: presentation.referencesListSupported === "true"
    };
  }
  if (input.providerId === AGENT_SESSION_PROVIDER_ID) {
    const agentName = presentation.subtitle?.trim() || "";
    const title = normalizeAgentSessionMentionTitle(label) || label;
    const description = compactText(presentation.description);
    const summaryPreview =
      description || compactText(input.subtitle) || undefined;
    return {
      kind: "session",
      href: buildAgentSessionMentionHref(workspaceId, targetId),
      workspaceId,
      targetId,
      name: label,
      title,
      scope: mentionSessionScope({
        currentUserId: input.currentUserId,
        rawScope: scope.scope,
        userId: scope.userId
      }),
      initiatorName: "",
      agentName,
      status: presentation.status?.trim() || undefined,
      inputPreview: description || undefined,
      summaryPreview
    };
  }
  return null;
}

function normalizeMentionScope(
  scope?: Readonly<Record<string, string>>
): Partial<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(scope ?? {})
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0)
  );
}

function mentionSessionScope(input: {
  currentUserId: string;
  rawScope: string | undefined;
  userId?: string;
}): Extract<AgentContextMentionItem, { kind: "session" }>["scope"] {
  const rawScope = input.rawScope?.trim() ?? "";
  if (rawScope === "my_sessions" || rawScope === "collab_sessions") {
    return rawScope;
  }
  const userId = input.userId?.trim() ?? "";
  const currentUserId = input.currentUserId.trim();
  if (
    !userId ||
    !currentUserId ||
    userId === "local" ||
    currentUserId === "local"
  ) {
    return "my_sessions";
  }
  return userId === currentUserId ? "my_sessions" : "collab_sessions";
}

function dirnameFromProviderWorkspaceFileHref(href: string): string {
  const normalized = href.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}
