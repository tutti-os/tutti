import { resolveAgentMentionFileThumbnailUrl } from "../shared/mentionFilePresentation";
import { getOptionalAgentHostApi } from "../../agentActivityHost";
import type { RuntimeDiagnosticsDetailValue } from "../../shared/contracts/dto/debug";
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
  DEFAULT_AGENT_MENTION_FILTER,
  DEFAULT_MENTION_GROUP_PAGE_SIZE,
  groupIdsForFilter,
  mentionGroupPageSize,
  normalizeQuery,
  resolveMentionGroupItems,
  resolveMentionGroupTotalCount,
  shouldShowEmptyGroup
} from "./agentMentionSearchHelpers";
import { agentMentionFilterLabel } from "./AgentMentionLabels";
import type { AgentContextMentionItem } from "./agentRichText/agentFileMentionExtension";
import { normalizeAgentSessionMentionTitle } from "./agentRichText/agentFileMentionExtension";
import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import type {
  AgentContextMentionInsertResult,
  AgentContextMentionProvider
} from "./agentContextMentionProvider";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "./agentContextMentionProvider";
import type {
  MentionPaletteGroup,
  MentionPaletteState
} from "@tutti-os/ui-rich-text/at-panel";

export type AgentMentionFilterId =
  | "session"
  | "file"
  | "issue"
  | "agent"
  | "app";
export type AgentMentionGroupId =
  | "apps"
  | "agents"
  | "files"
  | "opened_files"
  | "agent_generated_files"
  | "my_sessions"
  | "collab_sessions"
  | "issues";

type AgentMentionRawGroupId = Exclude<AgentMentionGroupId, "files">;
type AgentMentionRawGroups = Record<
  AgentMentionRawGroupId,
  AgentContextMentionItem[]
>;
type AgentMentionTotalCounts = Partial<Record<AgentMentionGroupId, number>>;

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
  browseCacheTtlMs?: number;
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
const DEFAULT_BROWSE_CACHE_TTL_MS = 30_000;
const AGENT_MENTION_LIFECYCLE_LOG_PREFIX = "[agent-gui] mention-lifecycle";

interface AgentMentionBrowseFetchResult {
  providerDiagnostics: AgentMentionProviderQueryDiagnostic[];
  rawGroups: AgentMentionRawGroups;
  totalCounts: AgentMentionTotalCounts;
}

interface AgentMentionBrowseCacheEntry extends AgentMentionBrowseFetchResult {
  cachedAt: number;
}

type AgentMentionBrowseLoadReason = "open" | "preload";

interface AgentMentionLifecycleDiagnosticLog {
  event:
    | "browse.open"
    | "browse.preload"
    | "browse.cache"
    | "browse.fetch.start"
    | "browse.fetch.dedupe"
    | "browse.fetch.success"
    | "browse.fetch.error"
    | "browse.apply.skipped";
  details: Record<string, RuntimeDiagnosticsDetailValue>;
}

const sharedAgentMentionBrowseCache = new Map<
  string,
  AgentMentionBrowseCacheEntry
>();
const sharedAgentMentionBrowseFetches = new Map<
  string,
  Promise<AgentMentionBrowseFetchResult>
>();

// Bound the shared browse cache so long-lived renderer sessions cannot grow it
// without limit. Eviction happens on write (LRU-by-insertion-order); reads keep
// returning stale entries so the stale-while-revalidate path stays intact.
export const MAX_BROWSE_CACHE_ENTRIES = 64;

function writeBrowseCacheEntry(
  cacheKey: string,
  entry: AgentMentionBrowseCacheEntry
): void {
  // Re-insert so the freshly written key becomes the newest (Map preserves
  // insertion order), then drop the oldest keys past the cap.
  sharedAgentMentionBrowseCache.delete(cacheKey);
  sharedAgentMentionBrowseCache.set(cacheKey, entry);
  while (sharedAgentMentionBrowseCache.size > MAX_BROWSE_CACHE_ENTRIES) {
    const oldestKey = sharedAgentMentionBrowseCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    sharedAgentMentionBrowseCache.delete(oldestKey);
  }
}

// Defer speculative warm-up to a browser idle slot so it never blocks the
// caller's synchronous path (e.g. a composer focus handler) or a render commit.
// Falls back to a macrotask where requestIdleCallback is unavailable (jsdom,
// older runtimes). Returns a canceller the owner uses on teardown.
function scheduleIdleTask(task: () => void): () => void {
  const scope = globalThis as typeof globalThis & {
    requestIdleCallback?: (
      cb: () => void,
      opts?: { timeout: number }
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof scope.requestIdleCallback === "function") {
    const handle = scope.requestIdleCallback(() => task(), { timeout: 500 });
    return () => scope.cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
}

export function resetAgentMentionSearchBrowseCacheForTests(): void {
  sharedAgentMentionBrowseCache.clear();
  sharedAgentMentionBrowseFetches.clear();
}

(
  globalThis as typeof globalThis & {
    __tuttiResetAgentMentionSearchBrowseCacheForTests?: () => void;
  }
).__tuttiResetAgentMentionSearchBrowseCacheForTests =
  resetAgentMentionSearchBrowseCacheForTests;

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
  agentTarget: AGENT_TARGET_PROVIDER_ID,
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
  private readonly browseCacheTtlMs: number;
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
  private readonly totalCounts: AgentMentionTotalCounts = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private preloadCancel: (() => void) | null = null;
  private pendingPreloadKey: string | null = null;
  private requestId = 0;
  private disposed = false;
  private activeWorkspaceId = "";
  private currentUserId = "";
  private currentFilter: AgentMentionFilterId = DEFAULT_AGENT_MENTION_FILTER;
  private currentQuery = "";
  private currentSessionCwd = "";
  private currentFileSearchLimit: number;
  private currentIssueSearchLimit: number;
  private agentGeneratedBrowsePath: string | null = null;
  private rawGroups: AgentMentionRawGroups = emptyAgentMentionRawGroups();
  private state: AgentMentionSearchState = {
    status: "idle",
    query: "",
    mode: "browse",
    filter: DEFAULT_AGENT_MENTION_FILTER,
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
    this.browseCacheTtlMs =
      options.browseCacheTtlMs ?? DEFAULT_BROWSE_CACHE_TTL_MS;
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
    this.preloadCancel = scheduleIdleTask(() => {
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

  private startBrowseModeFetch(filter: AgentMentionFilterId): void {
    if (!this.activeWorkspaceId) {
      this.resetRawGroups();
      this.emitBrowseState("ready");
      return;
    }
    this.clearTimer();
    const requestId = ++this.requestId;
    const cacheKey = this.browseCacheKey({
      currentUserId: this.currentUserId,
      filter,
      sessionCwd: this.currentSessionCwd,
      workspaceId: this.activeWorkspaceId
    });
    this.logLifecycle("browse.open", {
      filter,
      providerIds: this.providerIdsForDiagnostics(),
      requestId,
      sessionCwdPresent: Boolean(this.currentSessionCwd),
      workspaceId: this.activeWorkspaceId
    });
    const cached = this.readBrowseCacheForBrowseInput({
      cacheKey,
      currentUserId: this.currentUserId,
      filter,
      sessionCwd: this.currentSessionCwd,
      workspaceId: this.activeWorkspaceId
    });
    this.logBrowseCacheState({
      cacheKey,
      cached,
      filter,
      reason: "open",
      workspaceId: this.activeWorkspaceId
    });
    if (cached.entry) {
      this.applyBrowseFetchResult(cached.entry);
      this.setState({
        status: "ready",
        query: "",
        mode: "browse",
        filter: this.currentFilter,
        categories: buildBrowseCategories(),
        groups: this.groupsFromRawGroups(),
        error: null
      });
      if (cached.isFresh) {
        return;
      }
    } else {
      this.rawGroups = emptyAgentMentionRawGroups();
      this.resetTotalCounts();
      this.emitBrowseState("loading");
    }
    void this.runBrowseSearch({
      workspaceId: this.activeWorkspaceId,
      currentUserId: this.currentUserId,
      requestId,
      filter,
      sessionCwd: this.currentSessionCwd
    });
  }

  private async runSearch(input: {
    workspaceId: string;
    currentUserId: string;
    query: string;
    requestId: number;
    filter: AgentMentionFilterId;
  }): Promise<void> {
    const startedAt = this.diagnosticNow();
    let providerDiagnostics: AgentMentionProviderQueryDiagnostic[] = [];
    try {
      const result = await this.fetchFilterResult({
        workspaceId: input.workspaceId,
        currentUserId: input.currentUserId,
        query: input.query,
        filter: input.filter,
        sessionCwd: this.currentSessionCwd,
        includeAgentGeneratedFiles: false
      });
      providerDiagnostics = result.providerDiagnostics;

      if (
        !this.canApply(
          input.requestId,
          input.workspaceId,
          input.query,
          input.filter
        )
      ) {
        return;
      }

      this.applyBrowseFetchResult(result);
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
        filter: input.filter,
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
      if (
        !this.canApply(
          input.requestId,
          input.workspaceId,
          input.query,
          input.filter
        )
      ) {
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
        filter: input.filter,
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
    sessionCwd: string;
  }): Promise<void> {
    const startedAt = this.diagnosticNow();
    let providerDiagnostics: AgentMentionProviderQueryDiagnostic[] = [];
    const cacheKey = this.browseCacheKey(input);
    try {
      const result = await this.loadBrowseFetchResult(input, cacheKey, "open");
      providerDiagnostics = result.providerDiagnostics;
      if (
        !this.canApply(input.requestId, input.workspaceId, "", input.filter)
      ) {
        this.logLifecycle("browse.apply.skipped", {
          filter: input.filter,
          requestId: input.requestId,
          reason: "open",
          workspaceId: input.workspaceId
        });
        return;
      }
      this.applyBrowseFetchResult(result);
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
        filter: input.filter,
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
      if (
        !this.canApply(input.requestId, input.workspaceId, "", input.filter)
      ) {
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
        filter: input.filter,
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

  private async loadBrowseFetchResult(
    input: {
      workspaceId: string;
      currentUserId: string;
      filter: AgentMentionFilterId;
      sessionCwd: string;
    },
    cacheKey: string,
    reason: AgentMentionBrowseLoadReason
  ): Promise<AgentMentionBrowseFetchResult> {
    const existingFetch = sharedAgentMentionBrowseFetches.get(cacheKey);
    if (existingFetch) {
      this.logLifecycle("browse.fetch.dedupe", {
        filter: input.filter,
        reason,
        workspaceId: input.workspaceId
      });
      return existingFetch;
    }
    const startedAt = this.diagnosticNow();
    this.logLifecycle("browse.fetch.start", {
      filter: input.filter,
      providerIds: this.providerIdsForDiagnostics(),
      reason,
      workspaceId: input.workspaceId
    });
    const fetchPromise = this.fetchBrowseResult(input)
      .then((result) => {
        writeBrowseCacheEntry(cacheKey, {
          ...result,
          cachedAt: this.diagnosticNow()
        });
        this.logLifecycle("browse.fetch.success", {
          durationMs: elapsedDiagnosticMs(this.diagnosticNow(), startedAt),
          filter: input.filter,
          itemCount: rawGroupItemCount(result.rawGroups),
          providerResults: providerDiagnosticsSummary(
            result.providerDiagnostics
          ),
          reason,
          workspaceId: input.workspaceId
        });
        return result;
      })
      .finally(() => {
        if (sharedAgentMentionBrowseFetches.get(cacheKey) === fetchPromise) {
          sharedAgentMentionBrowseFetches.delete(cacheKey);
        }
      });
    sharedAgentMentionBrowseFetches.set(cacheKey, fetchPromise);
    return fetchPromise;
  }

  private async fetchBrowseResult(input: {
    workspaceId: string;
    currentUserId: string;
    filter: AgentMentionFilterId;
    sessionCwd: string;
  }): Promise<AgentMentionBrowseFetchResult> {
    return this.fetchFilterResult({
      ...input,
      query: "",
      includeAgentGeneratedFiles: input.filter === "file"
    });
  }

  private async fetchFilterResult(input: {
    workspaceId: string;
    currentUserId: string;
    query: string;
    filter: AgentMentionFilterId;
    sessionCwd: string;
    includeAgentGeneratedFiles: boolean;
  }): Promise<AgentMentionBrowseFetchResult> {
    const providerDiagnostics: AgentMentionProviderQueryDiagnostic[] = [];
    switch (input.filter) {
      case "file": {
        const fileQuery = this.queryProviderMentionItemsById({
          providerId: FILE_PROVIDER_ID,
          workspaceId: input.workspaceId,
          currentUserId: input.currentUserId,
          query: input.query,
          limit: input.query ? this.currentFileSearchLimit : this.fileLimit,
          sessionCwd: input.sessionCwd,
          diagnostics: providerDiagnostics
        });
        const agentGeneratedFileQuery = input.includeAgentGeneratedFiles
          ? this.queryProviderMentionItemsById({
              providerId: AGENT_GENERATED_FILE_PROVIDER_ID,
              workspaceId: input.workspaceId,
              currentUserId: input.currentUserId,
              query: input.query,
              limit: this.fileLimit,
              sessionCwd: input.sessionCwd,
              diagnostics: providerDiagnostics
            })
          : Promise.resolve([] as AgentContextMentionItem[]);
        const [fileItems, agentGeneratedFileItems] = await Promise.all([
          fileQuery,
          agentGeneratedFileQuery
        ]);
        const rawGroups = emptyAgentMentionRawGroups();
        rawGroups.opened_files = fileItems.filter(
          (item) => item.kind === "file"
        );
        rawGroups.agent_generated_files = agentGeneratedFileItems.filter(
          (item) => item.kind === "file"
        );
        return {
          providerDiagnostics,
          rawGroups,
          totalCounts: totalCountsFromRawGroups(rawGroups)
        };
      }
      case "session": {
        const sessionItems = await this.queryProviderMentionItemsById({
          providerId: AGENT_SESSION_PROVIDER_ID,
          workspaceId: input.workspaceId,
          currentUserId: input.currentUserId,
          query: input.query,
          limit: DEFAULT_SESSION_LIMIT,
          sessionCwd: input.sessionCwd,
          diagnostics: providerDiagnostics
        });
        const rawGroups = emptyAgentMentionRawGroups();
        rawGroups.my_sessions = normalizeSessionMentionItemsForMySessions({
          currentUserId: input.currentUserId,
          items: sessionItems
        });
        return {
          providerDiagnostics,
          rawGroups,
          totalCounts: totalCountsFromRawGroups(rawGroups)
        };
      }
      case "issue": {
        const issueItems = await this.queryProviderMentionItemsById({
          providerId: WORKSPACE_ISSUE_PROVIDER_ID,
          workspaceId: input.workspaceId,
          currentUserId: input.currentUserId,
          query: input.query,
          limit: this.currentIssueSearchLimit,
          sessionCwd: input.sessionCwd,
          diagnostics: providerDiagnostics
        });
        const rawGroups = emptyAgentMentionRawGroups();
        rawGroups.issues = issueItems.filter(
          (item) => item.kind === "workspace-issue"
        );
        return {
          providerDiagnostics,
          rawGroups,
          totalCounts: totalCountsFromRawGroups(rawGroups)
        };
      }
      case "agent": {
        const agentItems = await this.queryProviderMentionItemsById({
          providerId: AGENT_TARGET_PROVIDER_ID,
          workspaceId: input.workspaceId,
          currentUserId: input.currentUserId,
          query: input.query,
          sessionCwd: input.sessionCwd,
          diagnostics: providerDiagnostics
        });
        const rawGroups = emptyAgentMentionRawGroups();
        rawGroups.agents = agentItems.filter(
          (item) => item.kind === "agent-target"
        );
        return {
          providerDiagnostics,
          rawGroups,
          totalCounts: totalCountsFromRawGroups(rawGroups)
        };
      }
      case "app": {
        const appItems = await this.queryProviderMentionItemsById({
          providerId: WORKSPACE_APP_PROVIDER_ID,
          workspaceId: input.workspaceId,
          currentUserId: input.currentUserId,
          query: input.query,
          sessionCwd: input.sessionCwd,
          diagnostics: providerDiagnostics
        });
        const rawGroups = emptyAgentMentionRawGroups();
        rawGroups.apps = appItems.filter(
          (item) => item.kind === "workspace-app"
        );
        return {
          providerDiagnostics,
          rawGroups,
          totalCounts: totalCountsFromRawGroups(rawGroups)
        };
      }
    }
  }

  private async queryProviderMentionItems(input: {
    provider: AgentContextMentionProvider;
    workspaceId: string;
    currentUserId: string;
    query: string;
    limit?: number;
    sessionCwd: string;
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
          sessionCwd: input.sessionCwd || undefined,
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

  private applyBrowseFetchResult(result: AgentMentionBrowseFetchResult): void {
    this.rawGroups = cloneAgentMentionRawGroups(result.rawGroups);
    this.resetTotalCounts();
    for (const [groupId, count] of Object.entries(result.totalCounts) as [
      AgentMentionGroupId,
      number
    ][]) {
      this.totalCounts[groupId] = count;
    }
  }

  private readBrowseCache(cacheKey: string): {
    entry: AgentMentionBrowseCacheEntry | null;
    isFresh: boolean;
  } {
    const entry = sharedAgentMentionBrowseCache.get(cacheKey);
    if (!entry) {
      return { entry: null, isFresh: false };
    }
    // Touch for LRU recency. We deliberately keep returning stale entries (no
    // delete here) so the stale-while-revalidate path can still surface them.
    sharedAgentMentionBrowseCache.delete(cacheKey);
    sharedAgentMentionBrowseCache.set(cacheKey, entry);
    const ageMs = this.diagnosticNow() - entry.cachedAt;
    const isFresh =
      this.browseCacheTtlMs >= 0 &&
      Number.isFinite(this.browseCacheTtlMs) &&
      ageMs <= this.browseCacheTtlMs;
    return { entry, isFresh };
  }

  private readBrowseCacheForBrowseInput(input: {
    cacheKey: string;
    workspaceId: string;
    currentUserId: string;
    filter: AgentMentionFilterId;
    sessionCwd: string;
  }): {
    entry: AgentMentionBrowseCacheEntry | null;
    isFresh: boolean;
  } {
    return this.readBrowseCache(input.cacheKey);
  }

  private browseCacheKey(input: {
    workspaceId: string;
    currentUserId: string;
    filter: AgentMentionFilterId;
    sessionCwd: string;
  }): string {
    return JSON.stringify({
      workspaceId: input.workspaceId,
      currentUserId: input.currentUserId,
      sessionCwd: input.sessionCwd,
      filter: input.filter,
      fileLimit: this.fileLimit,
      issueLimit: this.currentIssueSearchLimit,
      providerIds: [...this.contextMentionProviders.keys()].sort()
    });
  }

  private logBrowseCacheState(input: {
    cacheKey: string;
    cached: { entry: AgentMentionBrowseCacheEntry | null; isFresh: boolean };
    filter: AgentMentionFilterId;
    reason: AgentMentionBrowseLoadReason;
    workspaceId: string;
  }): void {
    this.logLifecycle("browse.cache", {
      ageMs: input.cached.entry
        ? elapsedDiagnosticMs(this.diagnosticNow(), input.cached.entry.cachedAt)
        : null,
      cacheKeyLength: input.cacheKey.length,
      cacheState: input.cached.entry
        ? input.cached.isFresh
          ? "fresh"
          : "stale"
        : "miss",
      filter: input.filter,
      itemCount: input.cached.entry
        ? rawGroupItemCount(input.cached.entry.rawGroups)
        : 0,
      reason: input.reason,
      workspaceId: input.workspaceId
    });
  }

  private logLifecycle(
    event: AgentMentionLifecycleDiagnosticLog["event"],
    details: Record<string, RuntimeDiagnosticsDetailValue>
  ): void {
    logAgentMentionLifecycleDiagnostic({ event, details });
  }

  private providerIdsForDiagnostics(): string {
    return [...this.contextMentionProviders.keys()].sort().join(",");
  }

  private async queryProviderMentionItemsById(input: {
    diagnostics: AgentMentionProviderQueryDiagnostic[];
    providerId: string;
    workspaceId: string;
    currentUserId: string;
    query: string;
    limit?: number;
    sessionCwd?: string;
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
              sessionCwd: input.sessionCwd ?? this.currentSessionCwd,
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
    return orderedGroupIds
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
        const visibleCount =
          groupId === "apps"
            ? items.length
            : Math.min(items.length, this.expandedCounts[groupId] ?? pageSize);
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
            groupId !== "apps" &&
            (items.length > visibleCount ||
              ((groupId === "opened_files" ||
                groupId === "files" ||
                groupId === "agent_generated_files") &&
                items.length >= this.currentFileSearchLimit) ||
              totalCount > visibleCount)
        } satisfies AgentMentionGroup;
      })
      .filter((group): group is AgentMentionGroup => group !== null);
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
    query: string,
    filter: AgentMentionFilterId
  ): boolean {
    return (
      !this.disposed &&
      requestId === this.requestId &&
      workspaceId === this.activeWorkspaceId &&
      query === this.currentQuery &&
      filter === this.currentFilter
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
      "agents",
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

  private resetRawGroups(): void {
    this.rawGroups = emptyAgentMentionRawGroups();
    this.resetTotalCounts();
  }

  private resetAgentGeneratedBrowsePath(): void {
    this.agentGeneratedBrowsePath = null;
  }

  private resetTotalCounts(): void {
    for (const groupId of [
      "files",
      "opened_files",
      "agent_generated_files",
      "my_sessions",
      "collab_sessions",
      "agents",
      "apps",
      "issues"
    ] as const) {
      delete this.totalCounts[groupId];
    }
  }

  private setState(state: AgentMentionSearchState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
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

function emptyAgentMentionRawGroups(): AgentMentionRawGroups {
  return {
    apps: [],
    agents: [],
    opened_files: [],
    agent_generated_files: [],
    my_sessions: [],
    collab_sessions: [],
    issues: []
  };
}

function cloneAgentMentionRawGroups(
  rawGroups: AgentMentionRawGroups
): AgentMentionRawGroups {
  return {
    apps: [...rawGroups.apps],
    agents: [...rawGroups.agents],
    opened_files: [...rawGroups.opened_files],
    agent_generated_files: [...rawGroups.agent_generated_files],
    my_sessions: [...rawGroups.my_sessions],
    collab_sessions: [...rawGroups.collab_sessions],
    issues: [...rawGroups.issues]
  };
}

function totalCountsFromRawGroups(
  rawGroups: AgentMentionRawGroups
): AgentMentionTotalCounts {
  return {
    apps: rawGroups.apps.length,
    agents: rawGroups.agents.length,
    opened_files: rawGroups.opened_files.length,
    agent_generated_files: rawGroups.agent_generated_files.length,
    my_sessions: rawGroups.my_sessions.length,
    collab_sessions: rawGroups.collab_sessions.length,
    issues: rawGroups.issues.length
  };
}

function rawGroupItemCount(rawGroups: AgentMentionRawGroups): number {
  return Object.values(rawGroups).reduce(
    (count, items) => count + items.length,
    0
  );
}

function providerDiagnosticsSummary(
  diagnostics: readonly AgentMentionProviderQueryDiagnostic[]
): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.providerId}:${diagnostic.status}:${diagnostic.resultCount}:${diagnostic.durationMs}`
    )
    .join(",");
}

function elapsedDiagnosticMs(now: number, startedAt: number): number {
  const durationMs = now - startedAt;
  return Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
}

function diagnosticErrorKind(error: unknown): string {
  if (error instanceof Error && error.name.trim()) {
    return error.name.trim();
  }
  if (error === null) {
    return "null";
  }
  return typeof error;
}

function logAgentMentionLifecycleDiagnostic(
  payload: AgentMentionLifecycleDiagnosticLog
): void {
  try {
    console.info(AGENT_MENTION_LIFECYCLE_LOG_PREFIX, JSON.stringify(payload));
  } catch {
    // Diagnostic logging must never affect mention search state.
  }
  try {
    getOptionalAgentHostApi()?.debug?.logRuntimeDiagnostics?.({
      source: "renderer-workspace-surface",
      level: "info",
      event: `agent-gui.mention.${payload.event}`,
      // i18n-check-ignore: Internal diagnostic log message.
      message: "Agent GUI mention search lifecycle event.",
      details: payload.details
    });
  } catch {
    // Diagnostic logging must never affect mention search state.
  }
}

function normalizeSessionMentionItemsForMySessions(input: {
  currentUserId: string;
  items: readonly AgentContextMentionItem[];
}): AgentContextMentionItem[] {
  return input.items
    .filter((item) => item.kind === "session")
    .filter((item) =>
      input.currentUserId ? item.scope === "my_sessions" : true
    )
    .map((item) =>
      item.scope === "my_sessions"
        ? item
        : { ...item, scope: "my_sessions" as const }
    );
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
      href: createRichTextMentionHref({
        providerId: input.providerId,
        entityId: targetId,
        label,
        scope
      }),
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
      href: createRichTextMentionHref({
        providerId: "workspace-issue",
        entityId: targetId,
        label,
        scope: {
          workspaceId,
          ...(scope.topicId ? { topicId: scope.topicId } : {})
        }
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
      href: createRichTextMentionHref({
        providerId: "workspace-app",
        entityId: appId,
        label,
        scope: { workspaceId }
      }),
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
  if (input.providerId === AGENT_TARGET_PROVIDER_ID) {
    const agentProviderId = presentation.agentProviderId?.trim() || undefined;
    return {
      kind: "agent-target",
      href: createRichTextMentionHref({
        providerId: "agent-target",
        entityId: targetId,
        label,
        scope: { workspaceId }
      }),
      workspaceId,
      targetId,
      name: label,
      description:
        compactText(presentation.description) ||
        compactText(presentation.subtitle) ||
        compactText(input.subtitle) ||
        undefined,
      agentProviderId,
      iconUrl: presentation.iconUrl?.trim() || undefined
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
      href: createRichTextMentionHref({
        providerId: "agent-session",
        entityId: targetId,
        label,
        scope: { workspaceId }
      }),
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
): Record<string, string> {
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
