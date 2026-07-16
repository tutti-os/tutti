import {
  type AgentActivitySession,
  type AgentSessionEngine,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import {
  createWorkspaceQueryCache,
  type WorkspaceQueryCache
} from "../../../shared/query/workspaceQueryCache";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import {
  agentGuiScheduler,
  type AgentGuiScheduledTask,
  type AgentGuiScheduler
} from "../agentGuiScheduler";
import {
  CONVERSATION_RAIL_SLOW_DIAGNOSTIC_THRESHOLD_MS,
  createConversationRailDiagnosticLogger,
  emitConversationRailFirstPagesDiagnostic,
  ConversationRailProviderSwitchDiagnosticTracker,
  type ConversationRailDiagnosticLogger,
  type ConversationRailRefreshReason
} from "./agentGuiConversationRailDiagnostics";
import {
  mergeConversationRailSessionIds,
  planRuntimeRailMembershipRefresh
} from "../model/agentGuiConversationRail";
import { projectConversationRailMembershipRecords } from "../model/agentGuiConversationRailMembershipRecords";
import {
  applyCachedConversationRailQuery,
  cachedConversationRailQueryFromFirstPages,
  replaceConversationRailFirstPages,
  updateConversationRailSectionPageState,
  writeConversationRailQueryCache,
  type CachedConversationRailQuery
} from "./agentGuiConversationRailQueryCache";
import {
  buildConversationRailQuerySnapshot,
  EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
  EMPTY_CONVERSATION_RAIL_QUERY_STATE,
  type AgentGUIConversationRailQuerySnapshot
} from "./agentGuiConversationRailQuerySnapshot";
import {
  agentTargetQueryInput,
  conversationRailScopeKey
} from "./agentGuiConversationRailQueryInput";
import { AgentGUIConversationRailDeferredRefresh } from "./AgentGUIConversationRailDeferredRefresh";
import { AgentGUIConversationRailTargetedPageRefresher } from "./AgentGUIConversationRailTargetedPageRefresher";
import type {
  ConversationRailQueryControllerInput,
  ConversationRailQueryRuntime,
  ConversationRailQueryScope
} from "./agentGuiConversationRailQueryControllerTypes";

export type { AgentGUIConversationRailQuerySnapshot } from "./agentGuiConversationRailQuerySnapshot";

const SECTION_PAGE_SIZE = 5;
export const CONVERSATION_SEARCH_DEBOUNCE_MS = 300;
export const CONVERSATION_RAIL_QUERY_CACHE_FRESH_MS = 30_000;

type Listener = (snapshot: AgentGUIConversationRailQuerySnapshot) => void;

export class AgentGUIConversationRailQueryController {
  readonly getSnapshot = (): AgentGUIConversationRailQuerySnapshot =>
    this.snapshot;
  readonly isInteractionLocked = (): boolean =>
    this.queryState.pending &&
    this.queryState.resolvedScopeKey !== this.railSectionQueryKey &&
    !(this.searchQuery && this.snapshot.railSearch.enabled);
  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private readonly engine: AgentSessionEngine;
  private readonly cacheFreshMs: number;
  private readonly cacheNow: () => number;
  private readonly diagnosticLogger: ConversationRailDiagnosticLogger;
  private readonly diagnosticNow: () => number;
  private readonly diagnosticSlowThresholdMs: number;
  private readonly getActiveConversationId: () => string | null;
  private readonly listeners = new Set<Listener>();
  private readonly runtime: ConversationRailQueryRuntime;
  private readonly scheduler: AgentGuiScheduler;
  private readonly workspaceId: string;
  private readonly sessionSectionsQueryCache: WorkspaceQueryCache<CachedConversationRailQuery>;
  private readonly providerSwitchDiagnostics: ConversationRailProviderSwitchDiagnosticTracker;
  private readonly pagingAbortControllers = new Map<string, AbortController>();
  private readonly targetedPageRefresher: AgentGUIConversationRailTargetedPageRefresher;
  private readonly deferredMembershipRefresh: AgentGUIConversationRailDeferredRefresh;
  private queryState = EMPTY_CONVERSATION_RAIL_QUERY_STATE;
  private searchState = EMPTY_CONVERSATION_SEARCH_QUERY_STATE;
  private snapshot!: AgentGUIConversationRailQuerySnapshot;
  private scope: ConversationRailQueryScope | null = null;
  private sectionAgentTargetId = "";
  private railSectionQueryKey: string | null = null;
  private searchQuery = "";
  private searchRequestKey: string | null = null;
  private searchAbortController: AbortController | null = null;
  private searchDebounceTask: AgentGuiScheduledTask | null = null;
  private pagingRequestSequence = 0;
  private searchRequestSequence = 0;
  private attached = false;
  private ingestingSessions = false;
  private previousMembershipRecords: ReturnType<
    typeof projectConversationRailMembershipRecords
  >;
  private unsubscribeEngine: (() => void) | null = null;

  constructor(input: ConversationRailQueryControllerInput) {
    this.cacheFreshMs =
      input.cacheFreshMs ?? CONVERSATION_RAIL_QUERY_CACHE_FRESH_MS;
    this.cacheNow = input.cacheNow ?? Date.now;
    this.diagnosticLogger =
      input.diagnosticLogger ??
      createConversationRailDiagnosticLogger(input.runtime);
    this.diagnosticNow = input.diagnosticNow ?? Date.now;
    this.diagnosticSlowThresholdMs =
      input.diagnosticSlowThresholdMs ??
      CONVERSATION_RAIL_SLOW_DIAGNOSTIC_THRESHOLD_MS;
    this.engine = input.engine;
    this.getActiveConversationId = input.getActiveConversationId;
    this.runtime = input.runtime;
    this.providerSwitchDiagnostics =
      new ConversationRailProviderSwitchDiagnosticTracker(
        this.diagnosticLogger,
        this.diagnosticNow,
        input.workspaceId
      );
    this.sessionSectionsQueryCache =
      input.sessionSectionsQueryCache ??
      (input.runtime.getSessionSectionsQueryCache?.(input.workspaceId) as
        | WorkspaceQueryCache<CachedConversationRailQuery>
        | undefined) ??
      createWorkspaceQueryCache<CachedConversationRailQuery>();
    this.scheduler = input.scheduler ?? agentGuiScheduler;
    this.workspaceId = input.workspaceId;
    this.targetedPageRefresher =
      new AgentGUIConversationRailTargetedPageRefresher({
        onResolved: (pages) => {
          this.upsertSessions(pages.flatMap(({ page }) => page.sessions));
          this.queryState = replaceConversationRailFirstPages({
            pages,
            queryState: this.queryState
          });
          this.writeCurrentQueryCache();
          this.emit();
        },
        runtime: this.runtime,
        workspaceId: this.workspaceId
      });
    this.deferredMembershipRefresh =
      new AgentGUIConversationRailDeferredRefresh((plan) => {
        if (plan.refreshSearch) this.requestSearch();
        if (plan.pageIds.length === 0) return;
        this.cancelPagingRequests();
        this.targetedPageRefresher.refresh({
          agentTargetId: this.sectionAgentTargetId,
          pageIds: plan.pageIds
        });
      });
    this.previousMembershipRecords = projectConversationRailMembershipRecords(
      this.engine.getSnapshot()
    );
    this.emit();
  }

  attach(): () => void {
    if (this.attached) return () => {};
    this.attached = true;
    this.unsubscribeEngine = this.engine.subscribe((state) => {
      this.handleEngineState(state);
    });
    if (this.scope) this.refreshFirstPages("attach");
    if (this.searchQuery) this.requestSearch();
    return () => this.detach();
  }

  configure(scope: ConversationRailQueryScope): void {
    const previousScopeKey = this.railSectionQueryKey;
    const previousAgentTargetId = this.sectionAgentTargetId;
    const sectionAgentTargetId =
      scope.conversationFilter.kind === "agentTarget"
        ? scope.conversationFilter.agentTargetId.trim()
        : "";
    const nextScopeKey = conversationRailScopeKey({
      conversationFilter: scope.conversationFilter,
      previewMode: scope.previewMode,
      workspaceId: this.workspaceId
    });
    const scopeChanged = nextScopeKey !== this.railSectionQueryKey;
    this.providerSwitchDiagnostics.configure({
      attached: this.attached,
      nextAgentTargetId: sectionAgentTargetId,
      nextScopeKey,
      previousAgentTargetId,
      previousScopeKey
    });
    this.scope = scope;
    this.sectionAgentTargetId = sectionAgentTargetId;
    this.railSectionQueryKey = nextScopeKey;
    if (!scopeChanged) return;

    this.cancelPagingRequests();
    this.targetedPageRefresher.cancel();
    this.deferredMembershipRefresh.clear();
    this.queryState = {
      ...this.queryState,
      pending: this.runtimeSectionsEnabled(),
      reconcilingSessionIds: []
    };
    this.emit();
    if (this.attached) this.refreshFirstPages("scope_change");
    if (this.searchQuery) this.requestSearch();
  }

  setSearchQuery(value: string): void {
    const query = value.trim();
    if (query === this.searchQuery) return;
    this.searchQuery = query;
    this.scheduleSearch();
  }

  readonly loadMoreSectionConversations = (
    section: ConversationSection
  ): void => {
    const scopeKey = this.railSectionQueryKey;
    if (
      this.scope?.previewMode ||
      !scopeKey ||
      this.queryState.pending ||
      this.queryState.resolvedScopeKey !== scopeKey
    ) {
      return;
    }
    const currentPageState = this.queryState.sectionPageStates.get(section.id);
    if (
      !currentPageState ||
      currentPageState.isLoading ||
      !currentPageState.hasMore
    ) {
      return;
    }
    const membership = this.queryState.sections?.find(
      (candidate) => candidate.id === section.id
    );
    if (!membership) return;
    const listPage =
      membership.kind === "pinned"
        ? this.runtime.listPinnedSessionsPage
        : this.runtime.listSessionSectionPage;
    if (!listPage) return;

    const requestSequence = this.pagingRequestSequence;
    const abortController = new AbortController();
    this.pagingAbortControllers.set(section.id, abortController);
    this.queryState = {
      ...this.queryState,
      sectionPageStates: updateConversationRailSectionPageState(
        this.queryState.sectionPageStates,
        section.id,
        { ...currentPageState, isLoading: true }
      )
    };
    this.emit();

    const request =
      membership.kind === "pinned"
        ? this.runtime.listPinnedSessionsPage!({
            ...agentTargetQueryInput(this.sectionAgentTargetId),
            cursor: currentPageState.nextCursor || undefined,
            limit: SECTION_PAGE_SIZE,
            signal: abortController.signal,
            workspaceId: this.workspaceId
          })
        : this.runtime.listSessionSectionPage!({
            ...agentTargetQueryInput(this.sectionAgentTargetId),
            cursor: currentPageState.nextCursor || undefined,
            limit: SECTION_PAGE_SIZE,
            sectionKey: section.id,
            signal: abortController.signal,
            workspaceId: this.workspaceId
          });

    void request
      .then((page) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.pagingRequestSequence
        ) {
          return;
        }
        this.upsertSessions(page.sessions);
        this.queryState = {
          ...this.queryState,
          sectionPageStates: updateConversationRailSectionPageState(
            this.queryState.sectionPageStates,
            section.id,
            {
              hasMore: page.hasMore,
              isLoading: false,
              nextCursor: page.nextCursor ?? null,
              totalCount: page.totalCount
            }
          ),
          sections:
            this.queryState.sections?.map((candidate) =>
              candidate.id === section.id
                ? {
                    ...candidate,
                    sessionIds: mergeConversationRailSessionIds(
                      candidate.sessionIds,
                      page.sessions.map((session) => session.agentSessionId)
                    )
                  }
                : candidate
            ) ?? null
        };
        this.writeCurrentQueryCache();
        this.emit();
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.pagingRequestSequence
        ) {
          return;
        }
        this.queryState = {
          ...this.queryState,
          sectionPageStates: updateConversationRailSectionPageState(
            this.queryState.sectionPageStates,
            section.id,
            { ...currentPageState, isLoading: false }
          )
        };
        this.writeCurrentQueryCache();
        this.emit();
      })
      .finally(() => {
        if (this.pagingAbortControllers.get(section.id) === abortController) {
          this.pagingAbortControllers.delete(section.id);
        }
      });
  };

  readonly loadMoreSearchResults = (): void => {
    const listSessionsPage = this.runtime.listSessionsPage;
    if (
      !this.searchEnabled() ||
      !listSessionsPage ||
      this.searchState.pending ||
      this.searchState.loadingMore ||
      !this.searchState.hasMore ||
      !this.searchState.nextCursor ||
      this.searchState.requestKey !== this.searchRequestKey ||
      this.searchState.resolvedQuery !== this.searchQuery
    ) {
      return;
    }
    const requestSequence = this.searchRequestSequence;
    const abortController = new AbortController();
    this.searchAbortController?.abort();
    this.searchAbortController = abortController;
    this.searchState = { ...this.searchState, loadingMore: true };
    this.emit();
    void listSessionsPage({
      ...agentTargetQueryInput(this.sectionAgentTargetId),
      cursor: this.searchState.nextCursor ?? undefined,
      limit: 100,
      searchQuery: this.searchQuery,
      signal: abortController.signal,
      workspaceId: this.workspaceId
    })
      .then((page) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.searchRequestSequence
        ) {
          return;
        }
        this.upsertSessions(page.sessions);
        this.searchState = {
          ...this.searchState,
          failed: false,
          hasMore: page.hasMore,
          loadingMore: false,
          nextCursor: page.nextCursor ?? null,
          sessionIds: mergeConversationRailSessionIds(
            this.searchState.sessionIds,
            page.sessions.map((session) => session.agentSessionId)
          )
        };
        this.emit();
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.searchRequestSequence
        ) {
          return;
        }
        this.searchState = {
          ...this.searchState,
          failed: true,
          loadingMore: false
        };
        this.emit();
      });
  };

  readonly retrySearchResults = (): void => {
    if (!this.searchQuery || !this.searchEnabled()) return;
    this.requestSearch();
  };

  private handleEngineState(state: AgentSessionEngineState): void {
    const next = projectConversationRailMembershipRecords(state);
    if (this.ingestingSessions || !this.runtimeSectionsEnabled()) {
      this.previousMembershipRecords = next;
      return;
    }
    const plan = planRuntimeRailMembershipRefresh({
      activeConversationId: this.getActiveConversationId(),
      agentTargetId: this.sectionAgentTargetId || null,
      loadedSections: this.queryState.sections,
      next,
      previous: this.previousMembershipRecords,
      searchActive: Boolean(this.searchQuery && this.searchEnabled())
    });
    this.previousMembershipRecords = next;
    if (plan.kind !== "refresh_pages") return;
    if (plan.pageIds.length > 0 && this.railSectionQueryKey) {
      this.sessionSectionsQueryCache.invalidate(this.railSectionQueryKey);
    }
    this.queryState = {
      ...this.queryState,
      reconcilingSessionIds: mergeConversationRailSessionIds(
        this.queryState.reconcilingSessionIds,
        plan.reconcilingSessionIds
      )
    };
    this.emit();
    if (
      this.deferredMembershipRefresh.deferIfPending(
        this.queryState.pending,
        plan
      )
    )
      return;
    if (plan.refreshSearch) this.requestSearch();
    this.cancelPagingRequests();
    this.targetedPageRefresher.refresh({
      agentTargetId: this.sectionAgentTargetId,
      pageIds: plan.pageIds
    });
  }

  private refreshFirstPages(
    refreshReason: ConversationRailRefreshReason
  ): void {
    const listSections = this.runtime.listSessionSections;
    const scopeKey = this.railSectionQueryKey;
    if (!this.runtimeSectionsEnabled() || !listSections || !scopeKey) {
      this.queryState = EMPTY_CONVERSATION_RAIL_QUERY_STATE;
      this.emit();
      return;
    }
    const cached = this.sessionSectionsQueryCache.read(scopeKey);
    const cacheApplyStartedAt =
      cached && this.providerSwitchDiagnostics.hasPending(scopeKey)
        ? this.diagnosticNow()
        : null;
    if (cached && this.queryState.resolvedScopeKey !== scopeKey) {
      this.applyCachedFirstPages(scopeKey, cached);
      this.emit();
    }
    if (
      cached &&
      !cached.stale &&
      this.cacheNow() - cached.resolvedAtUnixMs <= this.cacheFreshMs
    ) {
      this.providerSwitchDiagnostics.complete(scopeKey, {
        cacheStatus: "fresh",
        controllerApplyMs:
          cacheApplyStartedAt === null
            ? 0
            : Math.max(0, this.diagnosticNow() - cacheApplyStartedAt),
        requestMs: 0,
        returnedSessionCount: cached.value.returnedSessionCount,
        sectionCount: cached.value.sectionCount,
        status: "ready"
      });
      this.flushDeferredMembershipRefresh();
      return;
    }
    const cacheStatus = cached ? "stale" : "miss";
    this.providerSwitchDiagnostics.setCacheStatus(scopeKey, cacheStatus);
    this.pagingRequestSequence += 1;
    const requestSequence = this.pagingRequestSequence;
    const requestStartedAt = this.diagnosticNow();
    const wasResolvedForScope =
      this.queryState.resolvedScopeKey === scopeKey &&
      this.queryState.sections !== null;
    this.cancelPagingRequests(false);
    this.queryState = {
      ...this.queryState,
      pending: true
    };
    this.emit();
    void this.sessionSectionsQueryCache
      .request(scopeKey, async () => {
        const page = await listSections({
          ...agentTargetQueryInput(this.sectionAgentTargetId),
          limitPerSection: SECTION_PAGE_SIZE,
          workspaceId: this.workspaceId
        });
        return cachedConversationRailQueryFromFirstPages(page, scopeKey);
      })
      .then((entry) => {
        if (
          requestSequence !== this.pagingRequestSequence ||
          scopeKey !== this.railSectionQueryKey
        ) {
          return;
        }
        const requestResolvedAt = this.diagnosticNow();
        this.applyCachedFirstPages(scopeKey, entry);
        this.emit();
        const completedAt = this.diagnosticNow();
        this.providerSwitchDiagnostics.complete(scopeKey, {
          cacheStatus,
          controllerApplyMs: Math.max(0, completedAt - requestResolvedAt),
          requestMs: Math.max(0, requestResolvedAt - requestStartedAt),
          returnedSessionCount: entry.value.returnedSessionCount,
          sectionCount: entry.value.sectionCount,
          status: "ready"
        });
        emitConversationRailFirstPagesDiagnostic({
          agentTargetId: this.sectionAgentTargetId || null,
          controllerApplyMs: Math.max(0, completedAt - requestResolvedAt),
          diagnosticLogger: this.diagnosticLogger,
          diagnosticSlowThresholdMs: this.diagnosticSlowThresholdMs,
          durationMs: Math.max(0, completedAt - requestStartedAt),
          requestId: requestSequence,
          requestMs: Math.max(0, requestResolvedAt - requestStartedAt),
          refreshReason,
          returnedSessionCount: entry.value.returnedSessionCount,
          sectionCount: entry.value.sectionCount,
          status: "ready",
          workspaceId: this.workspaceId
        });
        this.flushDeferredMembershipRefresh();
      })
      .catch((error: unknown) => {
        if (
          requestSequence !== this.pagingRequestSequence ||
          scopeKey !== this.railSectionQueryKey
        ) {
          return;
        }
        const failedAt = this.diagnosticNow();
        this.providerSwitchDiagnostics.complete(scopeKey, {
          cacheStatus,
          controllerApplyMs: 0,
          error,
          requestMs: Math.max(0, failedAt - requestStartedAt),
          returnedSessionCount: 0,
          sectionCount: 0,
          status: "error"
        });
        emitConversationRailFirstPagesDiagnostic({
          agentTargetId: this.sectionAgentTargetId || null,
          controllerApplyMs: 0,
          diagnosticLogger: this.diagnosticLogger,
          diagnosticSlowThresholdMs: this.diagnosticSlowThresholdMs,
          durationMs: Math.max(0, failedAt - requestStartedAt),
          error,
          requestId: requestSequence,
          requestMs: Math.max(0, failedAt - requestStartedAt),
          refreshReason,
          returnedSessionCount: 0,
          sectionCount: 0,
          status: "error",
          workspaceId: this.workspaceId
        });
        this.queryState = wasResolvedForScope
          ? {
              ...this.queryState,
              pending: false,
              reconcilingSessionIds: []
            }
          : {
              pending: false,
              reconcilingSessionIds: [],
              resolvedScopeKey: scopeKey,
              sectionPageStates: new Map(),
              sections: []
            };
        this.emit();
        this.flushDeferredMembershipRefresh();
      });
  }

  private flushDeferredMembershipRefresh(): void {
    this.deferredMembershipRefresh.flushIfReady(
      !this.queryState.pending &&
        this.queryState.resolvedScopeKey === this.railSectionQueryKey &&
        this.queryState.sections !== null &&
        this.queryState.sections.length > 0
    );
  }

  private applyCachedFirstPages(
    scopeKey: string,
    entry: ReturnType<
      WorkspaceQueryCache<CachedConversationRailQuery>["read"]
    > &
      object
  ): void {
    this.queryState = applyCachedConversationRailQuery({
      cache: this.sessionSectionsQueryCache,
      entry,
      scopeKey,
      upsertSessions: (sessions) => this.upsertSessions(sessions)
    });
  }

  private writeCurrentQueryCache(): void {
    writeConversationRailQueryCache({
      cache: this.sessionSectionsQueryCache,
      queryState: this.queryState,
      scopeKey: this.railSectionQueryKey
    });
  }

  private requestSearch(): void {
    this.clearSearchDebounceTimer();
    this.searchRequestKey =
      this.searchEnabled() && this.searchQuery
        ? JSON.stringify([
            this.workspaceId,
            this.sectionAgentTargetId,
            this.searchQuery
          ])
        : null;
    this.searchRequestSequence += 1;
    const requestSequence = this.searchRequestSequence;
    this.searchAbortController?.abort();
    this.searchAbortController = null;
    const listSessionsPage = this.runtime.listSessionsPage;
    if (!this.searchRequestKey || !listSessionsPage) {
      this.searchState = EMPTY_CONVERSATION_SEARCH_QUERY_STATE;
      this.emit();
      return;
    }
    const requestKey = this.searchRequestKey;
    const query = this.searchQuery;
    const abortController = new AbortController();
    this.searchAbortController = abortController;
    this.searchState = {
      ...EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
      pending: true,
      requestKey
    };
    this.emit();
    void listSessionsPage({
      ...agentTargetQueryInput(this.sectionAgentTargetId),
      limit: 100,
      searchQuery: query,
      signal: abortController.signal,
      workspaceId: this.workspaceId
    })
      .then((page) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.searchRequestSequence ||
          requestKey !== this.searchRequestKey
        ) {
          return;
        }
        this.upsertSessions(page.sessions);
        this.searchState = {
          failed: false,
          hasMore: page.hasMore,
          loadingMore: false,
          nextCursor: page.nextCursor ?? null,
          pending: false,
          requestKey,
          resolvedQuery: query,
          sessionIds: page.sessions.map((session) => session.agentSessionId)
        };
        this.emit();
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.searchRequestSequence ||
          requestKey !== this.searchRequestKey
        ) {
          return;
        }
        this.searchState = {
          ...EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
          failed: true,
          requestKey,
          resolvedQuery: query
        };
        this.emit();
      });
  }

  private scheduleSearch(): void {
    this.clearSearchDebounceTimer();
    this.searchRequestSequence += 1;
    this.searchAbortController?.abort();
    this.searchAbortController = null;

    if (!this.searchQuery || !this.searchEnabled()) {
      this.requestSearch();
      return;
    }

    this.searchRequestKey = null;
    this.emit();
    // timing: wait for a quiet input window before querying conversation history
    this.searchDebounceTask = this.scheduler.schedule(
      CONVERSATION_SEARCH_DEBOUNCE_MS,
      () => {
        this.searchDebounceTask = null;
        this.requestSearch();
      }
    );
  }

  private clearSearchDebounceTimer(): void {
    this.searchDebounceTask?.cancel();
    this.searchDebounceTask = null;
  }

  private upsertSessions(sessions: readonly AgentActivitySession[]): void {
    if (sessions.length === 0) return;
    this.ingestingSessions = true;
    try {
      this.engine.dispatch({ type: "session/snapshotReceived", sessions });
    } finally {
      this.ingestingSessions = false;
      this.previousMembershipRecords = projectConversationRailMembershipRecords(
        this.engine.getSnapshot()
      );
    }
  }

  private runtimeSectionsEnabled(): boolean {
    return Boolean(
      !this.scope?.previewMode &&
      this.runtime.listSessionSections &&
      this.runtime.listSessionSectionPage
    );
  }

  private searchEnabled(): boolean {
    return Boolean(!this.scope?.previewMode && this.runtime.listSessionsPage);
  }

  private emit(): void {
    this.snapshot = buildConversationRailQuerySnapshot({
      queryState: this.queryState,
      runtimeSectionsEnabled: this.runtimeSectionsEnabled(),
      searchEnabled: this.searchEnabled(),
      searchQuery: this.searchQuery,
      searchRequestKey: this.searchRequestKey,
      searchState: this.searchState
    });
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private cancelPagingRequests(incrementSequence = true): void {
    if (incrementSequence) this.pagingRequestSequence += 1;
    for (const controller of this.pagingAbortControllers.values()) {
      controller.abort();
    }
    this.pagingAbortControllers.clear();
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.unsubscribeEngine?.();
    this.unsubscribeEngine = null;
    this.cancelPagingRequests();
    this.targetedPageRefresher.cancel();
    this.deferredMembershipRefresh.clear();
    this.clearSearchDebounceTimer();
    this.searchRequestSequence += 1;
    this.searchAbortController?.abort();
    this.searchAbortController = null;
  }
}
