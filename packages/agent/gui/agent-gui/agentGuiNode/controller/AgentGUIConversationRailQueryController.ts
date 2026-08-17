import {
  type AgentActivitySession,
  type AgentSessionEngine,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import {
  createWorkspaceQueryCache,
  type WorkspaceQueryCache
} from "../../../shared/query/workspaceQueryCache";
import {
  agentGuiScheduler,
  type AgentGuiScheduler
} from "../agentGuiScheduler";
import {
  CONVERSATION_RAIL_SLOW_DIAGNOSTIC_THRESHOLD_MS,
  conversationRailQuerySessionIds,
  createConversationRailDiagnosticLogger,
  ConversationRailProviderSwitchDiagnosticTracker,
  type ConversationRailDiagnosticLogger,
  type ConversationRailRefreshReason
} from "./agentGuiConversationRailDiagnostics";
import {
  mergeConversationRailSessionIds,
  planRuntimeRailMembershipRefresh
} from "./agentConversationRailQueryModel";
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
  createConversationRailQuerySnapshotSelector,
  EMPTY_CONVERSATION_RAIL_QUERY_STATE,
  type AgentGUIConversationRailQuerySnapshot
} from "./agentConversationRailQuerySnapshot";
import type {
  ConversationRailQueryControllerInput,
  ConversationRailQueryRuntime,
  ConversationRailQueryScope
} from "./agentGuiConversationRailQueryTypes";
import { resolveConversationRailQueryScope } from "./agentGuiConversationRailQueryTypes";
import { AgentGUIConversationRailTargetedPageRefresher } from "./AgentGUIConversationRailTargetedPageRefresher";
import { requestConversationRailWithRetry } from "./agentGuiConversationRailRequestRetry";
import { AgentGUIConversationRailSearchController } from "./AgentGUIConversationRailSearchController";
import {
  createAgentGUIConversationActivityController,
  type AgentGUIConversationActivityController
} from "./agentGUIConversationActivityController";
export type { AgentGUIConversationRailQuerySnapshot } from "./agentConversationRailQuerySnapshot";
export type {
  ConversationRailQueryRuntime,
  ConversationRailQueryScope
} from "./agentGuiConversationRailQueryTypes";
export { CONVERSATION_SEARCH_DEBOUNCE_MS } from "./AgentGUIConversationRailSearchController";
const SECTION_PAGE_SIZE = 5;
const SECTION_REFRESH_LIMIT_MAX = 100;
type Listener = (snapshot: AgentGUIConversationRailQuerySnapshot) => void;
type PublicationRefreshState = "idle" | "pending" | "failed";
export class AgentGUIConversationRailQueryController {
  readonly activityController: AgentGUIConversationActivityController =
    createAgentGUIConversationActivityController();
  readonly getSnapshot = (): AgentGUIConversationRailQuerySnapshot =>
    this.snapshot;
  readonly isInteractionLocked = (): boolean =>
    this.sectionPublicationState === "pending" ||
    this.searchController.publicationBlocked ||
    (this.queryState.pending &&
      this.queryState.resolvedScopeKey !== this.railSectionQueryKey &&
      !(this.searchController.searchQuery && this.snapshot.railSearch.enabled));
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
  private readonly nodeId: string | null;
  private readonly listeners = new Set<Listener>();
  private readonly runtime: ConversationRailQueryRuntime;
  private readonly scheduler: AgentGuiScheduler;
  private readonly sectionPageSize: number;
  private readonly sectionRefreshLimitMax: number;
  private readonly workspaceId: string;
  private readonly sessionSectionsQueryCache: WorkspaceQueryCache<CachedConversationRailQuery>;
  private readonly providerSwitchDiagnostics: ConversationRailProviderSwitchDiagnosticTracker;
  private readonly pagingAbortControllers = new Map<string, AbortController>();
  private readonly searchController: AgentGUIConversationRailSearchController;
  private readonly targetedPageRefresher: AgentGUIConversationRailTargetedPageRefresher;
  private firstPageAbortController: AbortController | null = null;
  private firstPageRequest: {
    promise: Promise<void>;
    scopeKey: string;
  } | null = null;
  private queryState = EMPTY_CONVERSATION_RAIL_QUERY_STATE;
  private snapshot!: AgentGUIConversationRailQuerySnapshot;
  private scope: ConversationRailQueryScope | null = null;
  private sectionAgentTargetId = "";
  private railSectionQueryKey: string | null = null;
  private pagingRequestSequence = 0;
  private attached = false;
  private ingestingSessions = false;
  private queryFailed = false;
  private sectionPublicationState: PublicationRefreshState = "idle";
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
    this.nodeId = input.nodeId?.trim() || null;
    this.runtime = input.runtime;
    this.providerSwitchDiagnostics =
      new ConversationRailProviderSwitchDiagnosticTracker(
        this.diagnosticLogger,
        this.diagnosticNow,
        {
          nodeId: this.nodeId,
          runtimeOrigin: input.engine.identity.origin,
          workspaceId: input.workspaceId
        },
        this.diagnosticSlowThresholdMs
      );
    this.sessionSectionsQueryCache =
      input.sessionSectionsQueryCache ??
      createWorkspaceQueryCache<CachedConversationRailQuery>();
    this.scheduler = input.scheduler ?? agentGuiScheduler;
    this.sectionPageSize = positiveInteger(
      input.sectionPageSize,
      SECTION_PAGE_SIZE
    );
    this.sectionRefreshLimitMax = Math.max(
      this.sectionPageSize,
      positiveInteger(input.sectionRefreshLimitMax, SECTION_REFRESH_LIMIT_MAX)
    );
    this.workspaceId = input.workspaceId;
    const initialEngineState = this.engine.getSnapshot();
    this.searchController = new AgentGUIConversationRailSearchController({
      isSectionPublicationBlocked: () =>
        this.sectionPublicationState !== "idle",
      listSessionsPage: this.runtime.listSessionsPage,
      onChanged: () => this.publishIfReady(undefined, true),
      scheduler: this.scheduler,
      upsertSessions: (sessions) => this.upsertSessions(sessions),
      workspaceId: this.workspaceId
    });
    this.targetedPageRefresher =
      new AgentGUIConversationRailTargetedPageRefresher({
        onResolved: (pages) => {
          this.queryFailed = false;
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
          this.failTargetedPageRefresh();
        },
        onRetryScheduled: (mode) => {
          if (mode === "background") this.failTargetedPageRefresh();
        },
        pageSize: this.sectionPageSize,
        runtime: this.runtime,
        scheduler: this.scheduler,
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
      void this.refreshFirstPages("attach");
    }
    if (this.searchController.searchQuery) {
      this.searchController.request();
    }
    return () => this.detach();
  }
  refresh(): Promise<void> {
    if (!this.attached || !this.railSectionQueryKey) {
      return Promise.resolve();
    }
    this.sessionSectionsQueryCache.invalidate(this.railSectionQueryKey);
    return this.refreshFirstPages("manual");
  }
  configure(scope: ConversationRailQueryScope): void {
    const previousScopeKey = this.railSectionQueryKey;
    const previousAgentTargetId = this.sectionAgentTargetId;
    const previousFilterKind = this.scope?.conversationFilter.kind ?? null;
    const preservedSessionIds = conversationRailQuerySessionIds(
      this.queryState
    );
    const { agentTargetId: sectionAgentTargetId, scopeKey: nextScopeKey } =
      resolveConversationRailQueryScope(this.workspaceId, scope);
    const scopeChanged = nextScopeKey !== this.railSectionQueryKey;
    this.providerSwitchDiagnostics.configure({
      activeConversationId: this.getActiveConversationId(),
      attached: this.attached,
      nextFilterKind: scope.conversationFilter.kind,
      nextAgentTargetId: sectionAgentTargetId,
      nextScopeKey,
      preservedSectionCount: this.queryState.sections?.length ?? 0,
      preservedSessionIds,
      previousFilterKind,
      previousAgentTargetId,
      previousScopeKey,
      retainedPreviousSections:
        this.queryState.sections !== null &&
        this.queryState.resolvedScopeKey === previousScopeKey
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
    if (this.attached) void this.refreshFirstPages("scope_change");
    this.searchController.configureAgentTarget(this.sectionAgentTargetId);
  }
  setSearchQuery(value: string): void {
    this.searchController.setQuery(value);
  }
  readonly loadMoreSectionConversations = (section: { id: string }): void => {
    const scopeKey = this.railSectionQueryKey;
    if (
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
    this.queryFailed = false;
    this.publishIfReady(undefined, true);
    const request =
      membership.kind === "pinned"
        ? this.runtime.listPinnedSessionsPage!({
            agentTargetId: this.sectionAgentTargetId || undefined,
            cursor: currentPageState.nextCursor || undefined,
            limit: this.sectionPageSize,
            signal: abortController.signal,
            workspaceId: this.workspaceId
          })
        : this.runtime.listSessionSectionPage!({
            agentTargetId: this.sectionAgentTargetId || undefined,
            cursor: currentPageState.nextCursor || undefined,
            limit: this.sectionPageSize,
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
        this.queryFailed = false;
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
        this.queryFailed = true;
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
    this.searchController.loadMore();
  };
  readonly retrySearchResults = (): void => {
    this.searchController.retry();
  };
  private handleEngineState(state: AgentSessionEngineState): void {
    const next = projectConversationRailMembershipRecords(state);
    if (this.ingestingSessions) {
      this.previousMembershipRecords = next;
      return;
    }
    if (
      !this.runtimeSectionsEnabled() ||
      state.engineRuntime.workspaceReconcile.status === "loading" ||
      this.queryState.pending ||
      this.queryState.resolvedScopeKey !== this.railSectionQueryKey
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
      searchActive: Boolean(
        this.searchController.searchQuery && this.searchController.enabled
      )
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
    if (plan.refreshSearch) this.searchController.request(true);
    if (plan.pageIds.length > 0) {
      this.sectionPublicationState = "pending";
      this.cancelPagingRequests();
      this.targetedPageRefresher.refresh({
        agentTargetId: this.sectionAgentTargetId,
        pageIds: plan.pageIds
      });
    }
    this.publishIfReady(state);
  }
  private refreshFirstPages(
    refreshReason: ConversationRailRefreshReason
  ): Promise<void> {
    const listSections = this.runtime.listSessionSections;
    const scopeKey = this.railSectionQueryKey;
    if (!this.runtimeSectionsEnabled() || !listSections || !scopeKey) {
      this.queryState = EMPTY_CONVERSATION_RAIL_QUERY_STATE;
      this.sectionPublicationState = "idle";
      this.publishIfReady(undefined, true);
      return Promise.resolve();
    }
    if (this.firstPageRequest?.scopeKey === scopeKey) {
      return this.firstPageRequest.promise;
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
      this.providerSwitchDiagnostics.completeCachedFirstPages(scopeKey, {
        controllerApplyMs:
          cacheApplyStartedAt === null
            ? 0
            : Math.max(0, this.diagnosticNow() - cacheApplyStartedAt),
        query: cached.value
      });
      this.sectionPublicationState = "idle";
      this.publishIfReady(undefined, true);
      return Promise.resolve();
    }
    const cacheStatus = cached ? "stale" : "miss";
    this.providerSwitchDiagnostics.setCacheStatus(scopeKey, cacheStatus);
    this.pagingRequestSequence += 1;
    const requestSequence = this.pagingRequestSequence;
    const requestStartedAt = this.diagnosticNow();
    const wasResolvedForScope =
      this.queryState.resolvedScopeKey === scopeKey &&
      this.queryState.sections !== null;
    const queryStateForScope = wasResolvedForScope
      ? this.queryState
      : undefined;
    const agentTargetId = this.sectionAgentTargetId;
    const limitPerSection = this.firstPageLimit();
    this.cancelPagingRequests(false);
    this.queryState = {
      ...this.queryState,
      pending: true
    };
    this.queryFailed = false;
    this.publishIfReady(undefined, true);
    this.firstPageAbortController?.abort();
    const abortController = new AbortController();
    this.firstPageAbortController = abortController;
    const requestInput = {
      agentTargetId: agentTargetId || undefined,
      limitPerSection,
      signal: abortController.signal,
      workspaceId: this.workspaceId
    };
    const request = requestConversationRailWithRetry({
      onRetryScheduled: ({ mode }) => {
        if (
          mode !== "background" ||
          abortController.signal.aborted ||
          requestSequence !== this.pagingRequestSequence ||
          scopeKey !== this.railSectionQueryKey ||
          !this.attached
        ) {
          return;
        }
        this.failFirstPageRefresh({ scopeKey, wasResolvedForScope });
      },
      request: () => listSections(requestInput),
      retryKey: `${scopeKey}:first-pages`,
      scheduler: this.scheduler,
      signal: abortController.signal
    })
      .then((page) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.pagingRequestSequence ||
          scopeKey !== this.railSectionQueryKey ||
          !this.attached
        ) {
          return;
        }
        this.upsertSessions([
          ...(page.pinned?.sessions ?? []),
          ...page.sections.flatMap((section) => section.sessions)
        ]);
        const entry = this.sessionSectionsQueryCache.write(
          scopeKey,
          cachedConversationRailQueryFromFirstPages(
            page,
            scopeKey,
            this.queryState.resolvedScopeKey === scopeKey &&
              this.queryState.sections !== null
              ? this.queryState
              : queryStateForScope
          )
        );
        const requestResolvedAt = this.diagnosticNow();
        this.applyCachedFirstPages(entry);
        this.queryFailed = false;
        this.sectionPublicationState = "idle";
        this.publishIfReady(undefined, true);
        const completedAt = this.diagnosticNow();
        this.providerSwitchDiagnostics.completeFirstPages(scopeKey, {
          agentTargetId: this.sectionAgentTargetId || null,
          cacheStatus,
          completedAt,
          query: entry.value,
          refreshReason,
          requestId: requestSequence,
          requestResolvedAt,
          requestStartedAt
        });
      })
      .catch((error: unknown) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.pagingRequestSequence ||
          scopeKey !== this.railSectionQueryKey ||
          !this.attached
        ) {
          return;
        }
        this.queryFailed = true;
        const failedAt = this.diagnosticNow();
        this.providerSwitchDiagnostics.failFirstPages(scopeKey, {
          agentTargetId: this.sectionAgentTargetId || null,
          cacheStatus,
          error,
          failedAt,
          refreshReason,
          requestId: requestSequence,
          requestStartedAt
        });
        this.failFirstPageRefresh({ scopeKey, wasResolvedForScope });
      })
      .finally(() => {
        if (this.firstPageAbortController === abortController) {
          this.firstPageAbortController = null;
        }
        if (this.firstPageRequest?.promise === request) {
          this.firstPageRequest = null;
        }
      });
    this.firstPageRequest = { promise: request, scopeKey };
    return request;
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
      this.runtime.listSessionSections && this.runtime.listSessionSectionPage
    );
  }
  private publishIfReady(
    state: AgentSessionEngineState = this.engine.getSnapshot(),
    force = false
  ): void {
    if (this.publicationBlocked()) return;
    this.publish(state, force);
  }

  private publish(
    _state: AgentSessionEngineState = this.engine.getSnapshot(),
    force = false
  ): void {
    const snapshot = this.selectSnapshot(
      {
        agentTargetId: this.sectionAgentTargetId,
        queryState: this.queryState,
        runtimeRailFailed: this.queryFailed,
        runtimeSectionsEnabled: this.runtimeSectionsEnabled(),
        searchEnabled: this.searchController.enabled,
        searchQuery: this.searchController.searchQuery,
        searchRequestKey: this.searchController.searchRequestKey,
        searchState: this.searchController.queryState
      },
      this.snapshot,
      force
    );
    if (snapshot === this.snapshot) return;
    this.commitSnapshot(snapshot);
  }

  private failTargetedPageRefresh(): void {
    const alreadyPublished =
      this.queryFailed && this.sectionPublicationState === "failed";
    this.queryFailed = true;
    this.sectionPublicationState = "failed";
    if (this.railSectionQueryKey) {
      this.sessionSectionsQueryCache.invalidate(this.railSectionQueryKey);
    }
    if (!alreadyPublished) this.publishFailure();
  }

  private failFirstPageRefresh(input: {
    scopeKey: string;
    wasResolvedForScope: boolean;
  }): void {
    const alreadyPublished =
      this.queryFailed &&
      !this.queryState.pending &&
      this.queryState.resolvedScopeKey === input.scopeKey;
    const publicationWasBlocked = this.publicationBlocked();
    this.queryFailed = true;
    this.queryState = input.wasResolvedForScope
      ? {
          ...this.queryState,
          pending: false,
          reconcilingSessionIds: []
        }
      : {
          pending: false,
          reconcilingSessionIds: [],
          resolvedScopeKey: input.scopeKey,
          sectionPageStates: new Map(),
          sections: []
        };
    if (publicationWasBlocked) this.sectionPublicationState = "failed";
    if (alreadyPublished) return;
    if (publicationWasBlocked) {
      this.publishFailure();
    } else {
      this.publish(undefined, true);
    }
  }

  private publishFailure(): void {
    this.commitSnapshot({
      ...this.snapshot,
      runtimeRailFailed: true,
      sectionPageStates: this.queryState.sectionPageStates
    });
  }

  private commitSnapshot(
    snapshot: AgentGUIConversationRailQuerySnapshot
  ): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch (error) {
        // A host projection or presentation subscriber must not turn a
        // successful canonical query into a failed Rail refresh.
        void error;
      }
    }
  }

  private resetPublication(): void {
    this.sectionPublicationState = "idle";
    this.searchController.resetPublication();
  }

  private publicationBlocked(): boolean {
    return (
      this.sectionPublicationState !== "idle" ||
      this.searchController.publicationBlocked
    );
  }

  private firstPageLimit(): number {
    const loadedPerSection = (this.queryState.sections ?? []).reduce(
      (maximum, section) => Math.max(maximum, section.sessionIds.length),
      this.sectionPageSize
    );
    return Math.min(this.sectionRefreshLimitMax, loadedPerSection);
  }

  private cancelPagingRequests(incrementSequence = true): void {
    if (incrementSequence) this.pagingRequestSequence += 1;
    let sectionPageStates = this.queryState.sectionPageStates;
    for (const controller of this.pagingAbortControllers.values()) {
      controller.abort();
    }
    for (const sectionId of this.pagingAbortControllers.keys()) {
      const state = sectionPageStates.get(sectionId);
      if (state?.isLoading) {
        sectionPageStates = updateConversationRailSectionPageState(
          sectionPageStates,
          sectionId,
          { ...state, isLoading: false }
        );
      }
    }
    this.pagingAbortControllers.clear();
    if (sectionPageStates !== this.queryState.sectionPageStates) {
      this.queryState = { ...this.queryState, sectionPageStates };
    }
  }
  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.unsubscribeEngine?.();
    this.unsubscribeEngine = null;
    this.cancelPagingRequests();
    this.firstPageAbortController?.abort();
    this.firstPageAbortController = null;
    this.firstPageRequest = null;
    const settledPageStates = new Map(
      [...this.queryState.sectionPageStates].map(([sectionId, state]) => [
        sectionId,
        state.isLoading ? { ...state, isLoading: false } : state
      ])
    );
    this.queryState = {
      ...this.queryState,
      sectionPageStates: settledPageStates
    };
    this.targetedPageRefresher.cancel();
    if (this.publicationBlocked() && this.railSectionQueryKey) {
      this.sessionSectionsQueryCache.invalidate(this.railSectionQueryKey);
    }
    if (this.sectionPublicationState === "pending") {
      this.sectionPublicationState = "failed";
    }
    this.searchController.detach();
    this.publish(undefined, true);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}
