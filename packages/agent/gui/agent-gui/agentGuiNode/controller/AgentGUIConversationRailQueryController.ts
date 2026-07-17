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
  appendConversationRailSectionPage,
  applyCachedConversationRailQuery,
  cachedConversationRailQueryFromFirstPages,
  replaceConversationRailFirstPages,
  updateConversationRailSectionPageState,
  writeConversationRailQueryCache,
  type CachedConversationRailQuery
} from "./agentGuiConversationRailQueryCache";
import {
  appendConversationSearchPage,
  createConversationRailQuerySnapshotSelector,
  EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
  EMPTY_CONVERSATION_RAIL_QUERY_STATE,
  type AgentGUIConversationRailQuerySnapshot
} from "./agentGuiConversationRailQuerySnapshot";
import type {
  ConversationRailQueryControllerInput,
  ConversationRailQueryRuntime,
  ConversationRailQueryScope
} from "./agentGuiConversationRailQueryTypes";
import { resolveConversationRailQueryScope } from "./agentGuiConversationRailQueryTypes";
import { AgentGUIConversationRailTargetedPageRefresher } from "./AgentGUIConversationRailTargetedPageRefresher";
export type { AgentGUIConversationRailQuerySnapshot } from "./agentGuiConversationRailQuerySnapshot";
export type {
  ConversationRailQueryRuntime,
  ConversationRailQueryScope
} from "./agentGuiConversationRailQueryTypes";
const SECTION_PAGE_SIZE = 5;
export const CONVERSATION_SEARCH_DEBOUNCE_MS = 300;
type Listener = (snapshot: AgentGUIConversationRailQuerySnapshot) => void;
type PublicationRefreshState = "idle" | "pending" | "failed";
export class AgentGUIConversationRailQueryController {
  readonly getSnapshot = (): AgentGUIConversationRailQuerySnapshot =>
    this.snapshot;
  readonly isInteractionLocked = (): boolean =>
    this.publicationBlocked() ||
    (this.queryState.pending &&
      this.queryState.resolvedScopeKey !== this.railSectionQueryKey &&
      !(this.searchQuery && this.snapshot.railSearch.enabled));
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
  private sectionPublicationState: PublicationRefreshState = "idle";
  private searchPublicationState: PublicationRefreshState = "idle";
  private readonly selectSnapshot =
    createConversationRailQuerySnapshotSelector();
  private previousMembershipRecords: ReturnType<
    typeof projectConversationRailMembershipRecords
  >;
  private unsubscribeEngine: (() => void) | null = null;
  constructor(input: ConversationRailQueryControllerInput) {
    this.cacheFreshMs = input.cacheFreshMs ?? 30_000;
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
    const initialEngineState = this.engine.getSnapshot();
    this.targetedPageRefresher =
      new AgentGUIConversationRailTargetedPageRefresher({
        onResolved: (pages) => {
          this.upsertSessions(pages.flatMap(({ page }) => page.sessions));
          this.queryState = replaceConversationRailFirstPages({
            pages,
            queryState: this.queryState
          });
          this.writeCurrentQueryCache();
          this.sectionPublicationState = "idle";
          this.publishIfReady(undefined, true);
        },
        onFailed: () => {
          this.sectionPublicationState = "failed";
          if (this.railSectionQueryKey) {
            this.sessionSectionsQueryCache.invalidate(this.railSectionQueryKey);
          }
        },
        runtime: this.runtime,
        workspaceId: this.workspaceId
      });
    this.previousMembershipRecords =
      projectConversationRailMembershipRecords(initialEngineState);
    this.publish(initialEngineState, true);
  }
  attach(): () => void {
    if (this.attached) return () => {};
    this.attached = true;
    this.unsubscribeEngine = this.engine.subscribe((state) => {
      this.handleEngineState(state);
    });
    const engineState = this.engine.getSnapshot();
    this.handleEngineState(engineState);
    if (this.scope && this.sectionPublicationState !== "pending") {
      this.refreshFirstPages("attach");
    }
    if (this.searchQuery && this.searchPublicationState !== "pending") {
      this.requestSearch();
    }
    return () => this.detach();
  }
  configure(scope: ConversationRailQueryScope): void {
    const previousScopeKey = this.railSectionQueryKey;
    const previousAgentTargetId = this.sectionAgentTargetId;
    const { agentTargetId: sectionAgentTargetId, scopeKey: nextScopeKey } =
      resolveConversationRailQueryScope(this.workspaceId, scope);
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
    this.resetPublication();
    this.queryState = {
      ...this.queryState,
      pending: this.runtimeSectionsEnabled(),
      reconcilingSessionIds: []
    };
    this.publish(undefined, true);
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
      this.publicationBlocked() ||
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
    this.publishIfReady(undefined, true);
    const request =
      membership.kind === "pinned"
        ? this.runtime.listPinnedSessionsPage!({
            agentTargetId: this.sectionAgentTargetId || undefined,
            cursor: currentPageState.nextCursor || undefined,
            limit: SECTION_PAGE_SIZE,
            signal: abortController.signal,
            workspaceId: this.workspaceId
          })
        : this.runtime.listSessionSectionPage!({
            agentTargetId: this.sectionAgentTargetId || undefined,
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
        this.queryState = appendConversationRailSectionPage({
          page,
          queryState: this.queryState,
          sectionId: section.id
        });
        this.writeCurrentQueryCache();
        this.publishIfReady(undefined, true);
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
        this.publishIfReady(undefined, true);
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
      this.publicationBlocked() ||
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
    this.publishIfReady(undefined, true);
    void listSessionsPage({
      agentTargetId: this.sectionAgentTargetId || undefined,
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
        this.searchState = appendConversationSearchPage(this.searchState, page);
        this.publishIfReady(undefined, true);
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
        this.publishIfReady(undefined, true);
      });
  };
  readonly retrySearchResults = (): void => {
    if (!this.searchQuery || !this.searchEnabled()) return;
    this.requestSearch();
  };
  private handleEngineState(state: AgentSessionEngineState): void {
    const next = projectConversationRailMembershipRecords(state);
    if (this.ingestingSessions) {
      this.previousMembershipRecords = next;
      return;
    }
    if (
      !this.runtimeSectionsEnabled() ||
      state.engineRuntime.workspaceReconcile.status === "loading"
    ) {
      this.previousMembershipRecords = next;
      this.publishIfReady(state);
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
    if (plan.kind !== "refresh_pages") {
      this.publishIfReady(state);
      return;
    }
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
    if (plan.refreshSearch) this.requestSearch(true);
    if (plan.pageIds.length > 0) {
      this.cancelPagingRequests();
      this.sectionPublicationState = "pending";
      this.targetedPageRefresher.refresh({
        agentTargetId: this.sectionAgentTargetId,
        pageIds: plan.pageIds
      });
    }
    this.publishIfReady(state);
  }
  private refreshFirstPages(
    refreshReason: ConversationRailRefreshReason
  ): void {
    const listSections = this.runtime.listSessionSections;
    const scopeKey = this.railSectionQueryKey;
    if (!this.runtimeSectionsEnabled() || !listSections || !scopeKey) {
      this.queryState = EMPTY_CONVERSATION_RAIL_QUERY_STATE;
      this.sectionPublicationState = "idle";
      this.publishIfReady(undefined, true);
      return;
    }
    if (this.publicationBlocked()) {
      this.sectionPublicationState = "pending";
    }
    const cached = this.sessionSectionsQueryCache.read(scopeKey);
    const cacheApplyStartedAt =
      cached && this.providerSwitchDiagnostics.hasPending(scopeKey)
        ? this.diagnosticNow()
        : null;
    if (cached && this.queryState.resolvedScopeKey !== scopeKey) {
      this.applyCachedFirstPages(cached);
      this.publishIfReady(undefined, true);
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
      this.sectionPublicationState = "idle";
      this.publishIfReady(undefined, true);
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
    this.publishIfReady(undefined, true);
    void this.sessionSectionsQueryCache
      .request(scopeKey, async () => {
        const page = await listSections({
          agentTargetId: this.sectionAgentTargetId || undefined,
          limitPerSection: SECTION_PAGE_SIZE,
          workspaceId: this.workspaceId
        });
        this.upsertSessions([
          ...(page.pinned?.sessions ?? []),
          ...page.sections.flatMap((section) => section.sessions)
        ]);
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
      this.applyCachedFirstPages(entry);
      this.sectionPublicationState = "idle";
      this.publishIfReady(undefined, true);
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
        if (this.publicationBlocked()) {
          this.sectionPublicationState = "failed";
        } else {
          this.publish(undefined, true);
        }
      });
  }
  private applyCachedFirstPages(
    entry: ReturnType<
      WorkspaceQueryCache<CachedConversationRailQuery>["read"]
    > &
      object
  ): void {
    this.queryState = applyCachedConversationRailQuery({ entry });
  }
  private writeCurrentQueryCache(): void {
    writeConversationRailQueryCache({
      cache: this.sessionSectionsQueryCache,
      queryState: this.queryState,
      scopeKey: this.railSectionQueryKey
    });
  }
  private requestSearch(membershipRefresh = false): void {
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
      this.searchPublicationState = "idle";
      this.searchState = EMPTY_CONVERSATION_SEARCH_QUERY_STATE;
      this.publishIfReady(undefined, true);
      return;
    }
    const requestKey = this.searchRequestKey;
    const query = this.searchQuery;
    const tracksPublication = membershipRefresh || this.publicationBlocked();
    const abortController = new AbortController();
    this.searchAbortController = abortController;
    if (tracksPublication) this.searchPublicationState = "pending";
    this.searchState = {
      ...EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
      pending: true,
      requestKey
    };
    this.publishIfReady(undefined, true);
    void listSessionsPage({
      agentTargetId: this.sectionAgentTargetId || undefined,
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
        if (tracksPublication) {
          this.searchPublicationState = "idle";
          this.publishIfReady(undefined, true);
        } else {
          this.publishIfReady(undefined, true);
        }
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
        if (tracksPublication) {
          this.searchPublicationState = "failed";
        } else {
          this.publishIfReady(undefined, true);
        }
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
    this.publishIfReady(undefined, true);
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

  private publishIfReady(
    state: AgentSessionEngineState = this.engine.getSnapshot(),
    force = false
  ): void {
    if (this.publicationBlocked()) return;
    this.publish(state, force);
  }

  private publish(
    state: AgentSessionEngineState = this.engine.getSnapshot(),
    force = false
  ): void {
    const snapshot = this.selectSnapshot(
      {
        engineState: state,
        queryState: this.queryState,
        runtimeSectionsEnabled: this.runtimeSectionsEnabled(),
        searchEnabled: this.searchEnabled(),
        searchQuery: this.searchQuery,
        searchRequestKey: this.searchRequestKey,
        searchState: this.searchState
      },
      this.snapshot,
      force
    );
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private resetPublication(): void {
    this.sectionPublicationState = "idle";
    this.searchPublicationState = "idle";
  }

  private publicationBlocked(): boolean {
    return (
      this.sectionPublicationState !== "idle" ||
      this.searchPublicationState !== "idle"
    );
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
    if (this.publicationBlocked() && this.railSectionQueryKey) {
      this.sessionSectionsQueryCache.invalidate(this.railSectionQueryKey);
    }
    if (this.publicationBlocked()) {
      if (this.sectionPublicationState === "pending") {
        this.sectionPublicationState = "failed";
      }
      if (this.searchPublicationState === "pending") {
        this.searchPublicationState = "failed";
      }
    }
    this.clearSearchDebounceTimer();
    this.searchRequestSequence += 1;
    this.searchAbortController?.abort();
    this.searchAbortController = null;
  }
}
