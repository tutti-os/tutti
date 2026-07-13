import {
  DEFAULT_AGENT_MENTION_FILTER,
  DEFAULT_MENTION_GROUP_PAGE_SIZE,
  mentionGroupPageSize,
  normalizeQuery
} from "./agentMentionSearchHelpers";
import type { AgentContextMentionItem } from "./agentRichText/agentFileMentionExtension";
import type { AgentContextMentionProvider } from "./agentContextMentionProvider";
import {
  buildBrowseCategories,
  type AgentMentionFilterId,
  type AgentMentionGroupId,
  type AgentMentionSearchListener
} from "./AgentMentionSearchContracts";
import {
  scheduleAgentMentionIdleTask,
  MAX_BROWSE_CACHE_ENTRIES,
  resetAgentMentionSearchBrowseCacheForTests
} from "./AgentMentionSearchCache";
import { diagnosticErrorKind } from "./AgentMentionSearchModel";
import { AgentMentionSearchControllerBase } from "./AgentMentionSearchControllerBase";

export type {
  AgentMentionBrowseCategory,
  AgentMentionFilterId,
  AgentMentionGroup,
  AgentMentionGroupId,
  AgentMentionSearchState
} from "./AgentMentionSearchContracts";
export { MAX_BROWSE_CACHE_ENTRIES, resetAgentMentionSearchBrowseCacheForTests };

export class AgentMentionSearchController extends AgentMentionSearchControllerBase {
  subscribe(listener: AgentMentionSearchListener): () => void {
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
    this.resetRawGroups();

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
        requestId,
        filter: this.currentFilter
      });
    }, this.debounceMs);
  }

  setFilter(filter: AgentMentionFilterId): void {
    if (this.disposed) {
      return;
    }
    this.currentFilter = filter;
    this.clearTimer();
    const requestId = ++this.requestId;
    this.resetAgentGeneratedBrowsePath();
    this.resetExpandedCounts();
    this.resetSearchLimits();
    this.resetRawGroups();
    if (!this.currentQuery) {
      this.startBrowseModeFetch(filter);
      return;
    }
    if (!this.activeWorkspaceId) {
      this.setState({
        status: "ready",
        query: this.currentQuery,
        mode: "results",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: [],
        error: null
      });
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
    void this.runSearch({
      workspaceId: this.activeWorkspaceId,
      currentUserId: this.currentUserId,
      query: this.currentQuery,
      requestId,
      filter
    });
  }

  preloadBrowse(input: {
    workspaceId: string;
    currentUserId?: string | null;
    sessionCwd?: string | null;
    filter?: AgentMentionFilterId;
  }): void {
    if (this.disposed) {
      return;
    }
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) {
      return;
    }
    const filter = input.filter ?? DEFAULT_AGENT_MENTION_FILTER;
    const currentUserId = input.currentUserId?.trim() ?? "";
    const sessionCwd = input.sessionCwd?.trim() ?? "";
    const cacheKey = this.browseCacheKey({
      currentUserId,
      filter,
      sessionCwd,
      workspaceId
    });
    if (this.readBrowseCache(cacheKey).isFresh) {
      return;
    }
    if (this.pendingPreloadKey === cacheKey) {
      return;
    }
    this.cancelPendingPreload();
    this.pendingPreloadKey = cacheKey;
    this.preloadCancel = scheduleAgentMentionIdleTask(() => {
      this.preloadCancel = null;
      this.pendingPreloadKey = null;
      if (this.disposed) {
        return;
      }
      this.runBrowsePreload({
        cacheKey,
        currentUserId,
        filter,
        sessionCwd,
        workspaceId
      });
    });
  }

  private runBrowsePreload(input: {
    cacheKey: string;
    currentUserId: string;
    filter: AgentMentionFilterId;
    sessionCwd: string;
    workspaceId: string;
  }): void {
    const { cacheKey, currentUserId, filter, sessionCwd, workspaceId } = input;
    this.logLifecycle("browse.preload", {
      filter,
      providerIds: this.providerIdsForDiagnostics(),
      sessionCwdPresent: Boolean(sessionCwd),
      workspaceId
    });
    const cached = this.readBrowseCache(cacheKey);
    this.logBrowseCacheState({
      cacheKey,
      cached,
      filter,
      reason: "preload",
      workspaceId
    });
    if (cached.isFresh) {
      return;
    }
    void this.loadBrowseFetchResult(
      {
        workspaceId,
        currentUserId,
        filter,
        sessionCwd
      },
      cacheKey,
      "preload"
    ).catch((error) => {
      this.logLifecycle("browse.fetch.error", {
        errorKind: diagnosticErrorKind(error),
        filter,
        reason: "preload",
        workspaceId
      });
    });
  }

  private cancelPendingPreload(): void {
    if (this.preloadCancel) {
      this.preloadCancel();
      this.preloadCancel = null;
    }
    this.pendingPreloadKey = null;
  }

  enterCategory(category: AgentMentionFilterId): void {
    this.setFilter(category);
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

  exitAgentGeneratedBrowse(): boolean {
    if (!this.agentGeneratedBrowsePath) {
      return false;
    }
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

  expandGroup(groupId: AgentMentionGroupId): void {
    const pageSize = mentionGroupPageSize(this.currentFilter, groupId);
    const current = this.expandedCounts[groupId] ?? pageSize;
    this.expandedCounts[groupId] = current + pageSize;
    if (!this.currentQuery) {
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
        requestId,
        filter: this.currentFilter
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
    this.currentFilter = DEFAULT_AGENT_MENTION_FILTER;
    this.resetAgentGeneratedBrowsePath();
    this.resetExpandedCounts();
    this.resetSearchLimits();
    this.resetRawGroups();
    this.currentQuery = "";
    this.setState({
      status: "idle",
      query: "",
      mode: "browse",
      filter: DEFAULT_AGENT_MENTION_FILTER,
      categories: buildBrowseCategories(),
      groups: [],
      error: null
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.cancelPendingPreload();
    this.listeners.clear();
    this.requestId += 1;
  }
}

// Warm the shared browse cache without a mounted controller — e.g. from an app
// startup flow, so the first time the @ palette opens its results are already
// cached. Spins up a transient controller (no listeners, default limits/ttl) so
// the produced cacheKey matches a live composer controller built with the same
// providers; the global cache + in-flight dedup are reused, so this never
// double-fetches against a focus-driven preload. The instance holds no timers
// after the idle warm runs, so it is garbage-collected.
export function preloadAgentMentionBrowse(input: {
  workspaceId: string;
  currentUserId?: string | null;
  sessionCwd?: string | null;
  contextMentionProviders?: readonly AgentContextMentionProvider[];
  filter?: AgentMentionFilterId;
}): void {
  const controller = new AgentMentionSearchController({
    contextMentionProviders: input.contextMentionProviders
  });
  controller.preloadBrowse({
    workspaceId: input.workspaceId,
    currentUserId: input.currentUserId,
    sessionCwd: input.sessionCwd,
    filter: input.filter
  });
}
