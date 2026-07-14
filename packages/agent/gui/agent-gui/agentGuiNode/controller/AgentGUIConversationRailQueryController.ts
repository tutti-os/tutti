import {
  selectPendingActivations,
  selectWorkspaceAgentConsumerSessions,
  type AgentActivitySession,
  type AgentSessionEngine,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import {
  mergeConversationRailSessionIds,
  planRuntimeRailMembershipRefresh,
  projectRuntimeSectionsToConversationRailMemberships,
  type ConversationRailQueryState,
  type ConversationRailSectionMembership,
  type ConversationRailSectionPageState
} from "../model/agentGuiConversationRail";

const SECTION_PAGE_SIZE = 5;
const SEARCH_PAGE_SIZE = 100;

interface ConversationSearchQueryState {
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  pending: boolean;
  requestKey: string | null;
  resolvedQuery: string;
  sessionIds: readonly string[];
}

const EMPTY_SEARCH_STATE: ConversationSearchQueryState = {
  failed: false,
  hasMore: false,
  loadingMore: false,
  nextCursor: null,
  pending: false,
  requestKey: null,
  resolvedQuery: "",
  sessionIds: []
};

const EMPTY_QUERY_STATE: ConversationRailQueryState = {
  pending: false,
  reconcilingSessionIds: [],
  resolvedScopeKey: null,
  sectionPageStates: new Map(),
  sections: null
};

export interface ConversationRailQueryScope {
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  previewMode: boolean;
  sectionAgentTargetFallbackId: string | null;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
}

export interface AgentGUIConversationRailQuerySnapshot {
  railSearch: {
    enabled: boolean;
    failed: boolean;
    hasMore: boolean;
    loadingMore: boolean;
    pending: boolean;
    resolvedQuery: string;
    sessionIds: readonly string[];
  };
  runtimeSectionsEnabled: boolean;
  runtimeRailMemberships: ConversationRailSectionMembership[] | null;
  runtimeRailReconcilingSessionIds: readonly string[];
  runtimeRailSectionsPending: boolean;
  sectionPageStates: ConversationRailQueryState["sectionPageStates"];
}

interface ControllerInput {
  engine: AgentSessionEngine;
  getActiveConversationId(): string | null;
  runtime: ConversationRailQueryRuntime;
  workspaceId: string;
}

export type ConversationRailQueryRuntime = Pick<
  AgentActivityRuntime,
  | "listPinnedSessionsPage"
  | "listSessionSectionPage"
  | "listSessionSections"
  | "listSessionsPage"
>;

type Listener = (snapshot: AgentGUIConversationRailQuerySnapshot) => void;

export class AgentGUIConversationRailQueryController {
  readonly getSnapshot = (): AgentGUIConversationRailQuerySnapshot =>
    this.snapshot;
  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private readonly engine: AgentSessionEngine;
  private readonly getActiveConversationId: () => string | null;
  private readonly listeners = new Set<Listener>();
  private readonly runtime: ConversationRailQueryRuntime;
  private readonly workspaceId: string;
  private readonly pagingAbortControllers = new Map<string, AbortController>();
  private queryState = EMPTY_QUERY_STATE;
  private searchState = EMPTY_SEARCH_STATE;
  private snapshot: AgentGUIConversationRailQuerySnapshot;
  private scope: ConversationRailQueryScope | null = null;
  private sectionAgentTargetId = "";
  private railSectionQueryKey: string | null = null;
  private searchQuery = "";
  private searchRequestKey: string | null = null;
  private searchAbortController: AbortController | null = null;
  private pagingRequestSequence = 0;
  private searchRequestSequence = 0;
  private attached = false;
  private ingestingSessions = false;
  private previousMembershipRecords: ReturnType<typeof membershipRecords>;
  private unsubscribeEngine: (() => void) | null = null;

  constructor(input: ControllerInput) {
    this.engine = input.engine;
    this.getActiveConversationId = input.getActiveConversationId;
    this.runtime = input.runtime;
    this.workspaceId = input.workspaceId;
    this.previousMembershipRecords = membershipRecords(
      this.engine.getSnapshot()
    );
    this.snapshot = this.buildSnapshot();
  }

  attach(): () => void {
    if (this.attached) return () => {};
    this.attached = true;
    this.unsubscribeEngine = this.engine.subscribe((state) => {
      this.handleEngineState(state);
    });
    if (this.scope) this.refreshFirstPages();
    if (this.searchQuery) this.requestSearch();
    return () => this.detach();
  }

  configure(scope: ConversationRailQueryScope): void {
    const sectionAgentTargetId =
      scope.conversationFilter.kind === "agentTarget"
        ? scope.conversationFilter.agentTargetId.trim()
        : (scope.sectionAgentTargetFallbackId?.trim() ?? "");
    const userProjectPathKey = JSON.stringify(
      scope.userProjects
        .map((project) => project.path.trim())
        .filter((path) => path.length > 0)
    );
    const nextScopeKey = JSON.stringify([
      this.workspaceId,
      scope.conversationFilter.kind === "agentTarget"
        ? `agentTarget:${scope.conversationFilter.agentTargetId.trim()}`
        : "all",
      scope.previewMode,
      sectionAgentTargetId,
      userProjectPathKey
    ]);
    const scopeChanged = nextScopeKey !== this.railSectionQueryKey;
    this.scope = scope;
    this.sectionAgentTargetId = sectionAgentTargetId;
    this.railSectionQueryKey = nextScopeKey;
    if (!scopeChanged) return;

    this.cancelPagingRequests();
    this.queryState = {
      ...this.queryState,
      pending: this.runtimeSectionsEnabled(),
      reconcilingSessionIds: [],
      resolvedScopeKey: nextScopeKey
    };
    this.emit();
    if (this.attached) this.refreshFirstPages();
    if (this.searchQuery) this.requestSearch();
  }

  setSearchQuery(value: string): void {
    const query = value.trim();
    if (query === this.searchQuery) return;
    this.searchQuery = query;
    this.requestSearch();
  }

  loadMoreSectionConversations(section: ConversationSection): void {
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
      sectionPageStates: updateSectionPageState(
        this.queryState.sectionPageStates,
        section.id,
        { ...currentPageState, isLoading: true }
      )
    };
    this.emit();

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
        this.queryState = {
          ...this.queryState,
          sectionPageStates: updateSectionPageState(
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
          sectionPageStates: updateSectionPageState(
            this.queryState.sectionPageStates,
            section.id,
            { ...currentPageState, isLoading: false }
          )
        };
        this.emit();
      })
      .finally(() => {
        if (this.pagingAbortControllers.get(section.id) === abortController) {
          this.pagingAbortControllers.delete(section.id);
        }
      });
  }

  loadMoreSearchResults(): void {
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
      agentTargetId: this.sectionAgentTargetId || undefined,
      cursor: this.searchState.nextCursor ?? undefined,
      limit: SEARCH_PAGE_SIZE,
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
  }

  private handleEngineState(state: AgentSessionEngineState): void {
    const next = membershipRecords(state);
    if (this.ingestingSessions || !this.runtimeSectionsEnabled()) {
      this.previousMembershipRecords = next;
      return;
    }
    const plan = planRuntimeRailMembershipRefresh({
      activeConversationId: this.getActiveConversationId(),
      loadedSections: this.queryState.sections,
      next,
      previous: this.previousMembershipRecords
    });
    this.previousMembershipRecords = next;
    if (plan.kind !== "refresh_first_pages") return;
    this.queryState = {
      ...this.queryState,
      reconcilingSessionIds: mergeConversationRailSessionIds(
        this.queryState.reconcilingSessionIds,
        plan.reconcilingSessionIds
      )
    };
    this.emit();
    this.refreshFirstPages();
  }

  private refreshFirstPages(): void {
    const listSections = this.runtime.listSessionSections;
    const scopeKey = this.railSectionQueryKey;
    if (!this.runtimeSectionsEnabled() || !listSections || !scopeKey) {
      this.queryState = EMPTY_QUERY_STATE;
      this.emit();
      return;
    }
    this.pagingRequestSequence += 1;
    const requestSequence = this.pagingRequestSequence;
    this.cancelPagingRequests(false);
    const abortController = new AbortController();
    this.pagingAbortControllers.set("__first_pages__", abortController);
    this.queryState = {
      ...this.queryState,
      pending: true,
      resolvedScopeKey: scopeKey
    };
    this.emit();
    void listSections({
      agentTargetId: this.sectionAgentTargetId || undefined,
      limitPerSection: SECTION_PAGE_SIZE,
      signal: abortController.signal,
      workspaceId: this.workspaceId
    })
      .then((page) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.pagingRequestSequence ||
          scopeKey !== this.railSectionQueryKey
        ) {
          return;
        }
        const sections = projectRuntimeSectionsToConversationRailMemberships({
          pinned: page.pinned,
          sections: page.sections
        });
        this.upsertSessions([
          ...(page.pinned?.sessions ?? []),
          ...page.sections.flatMap((section) => section.sessions)
        ]);
        const sectionPageStates = new Map<
          string,
          ConversationRailSectionPageState
        >();
        if (page.pinned) {
          sectionPageStates.set("pinned", pageState(page.pinned));
        }
        for (const section of page.sections) {
          sectionPageStates.set(section.sectionKey, pageState(section));
        }
        this.queryState = {
          pending: false,
          reconcilingSessionIds: [],
          resolvedScopeKey: scopeKey,
          sectionPageStates,
          sections
        };
        this.emit();
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.pagingRequestSequence ||
          scopeKey !== this.railSectionQueryKey
        ) {
          return;
        }
        this.queryState = {
          ...this.queryState,
          pending: false,
          resolvedScopeKey: scopeKey,
          sectionPageStates: new Map(),
          sections: []
        };
        this.emit();
      })
      .finally(() => {
        if (
          this.pagingAbortControllers.get("__first_pages__") === abortController
        ) {
          this.pagingAbortControllers.delete("__first_pages__");
        }
      });
  }

  private requestSearch(): void {
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
      this.searchState = EMPTY_SEARCH_STATE;
      this.emit();
      return;
    }
    const requestKey = this.searchRequestKey;
    const query = this.searchQuery;
    const abortController = new AbortController();
    this.searchAbortController = abortController;
    this.searchState = {
      ...EMPTY_SEARCH_STATE,
      pending: true,
      requestKey
    };
    this.emit();
    void listSessionsPage({
      agentTargetId: this.sectionAgentTargetId || undefined,
      limit: SEARCH_PAGE_SIZE,
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
          ...EMPTY_SEARCH_STATE,
          failed: true,
          requestKey,
          resolvedQuery: query
        };
        this.emit();
      });
  }

  private upsertSessions(sessions: readonly AgentActivitySession[]): void {
    this.ingestingSessions = true;
    try {
      for (const session of sessions) {
        this.engine.dispatch({ type: "session/upserted", session });
      }
    } finally {
      this.ingestingSessions = false;
      this.previousMembershipRecords = membershipRecords(
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

  private buildSnapshot(): AgentGUIConversationRailQuerySnapshot {
    const searchResolved =
      this.searchState.requestKey === this.searchRequestKey &&
      this.searchState.resolvedQuery === this.searchQuery;
    return {
      railSearch: {
        enabled: this.searchEnabled(),
        failed: searchResolved && this.searchState.failed,
        hasMore: searchResolved && this.searchState.hasMore,
        loadingMore: searchResolved && this.searchState.loadingMore,
        pending:
          Boolean(this.searchQuery) &&
          (!searchResolved || this.searchState.pending),
        resolvedQuery: searchResolved ? this.searchState.resolvedQuery : "",
        sessionIds: searchResolved ? this.searchState.sessionIds : []
      },
      runtimeSectionsEnabled: this.runtimeSectionsEnabled(),
      runtimeRailMemberships: this.queryState.sections,
      runtimeRailReconcilingSessionIds: this.queryState.reconcilingSessionIds,
      runtimeRailSectionsPending: this.queryState.pending,
      sectionPageStates: this.queryState.sectionPageStates
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
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
    this.searchRequestSequence += 1;
    this.searchAbortController?.abort();
    this.searchAbortController = null;
  }
}

function membershipRecords(state: AgentSessionEngineState) {
  const sessions = selectWorkspaceAgentConsumerSessions(state);
  const canonicalIds = new Set(
    sessions.map((item) => item.session.agentSessionId)
  );
  return [
    ...sessions.map((item) => ({
      id: item.session.agentSessionId,
      pinnedAtUnixMs: item.session.pinnedAtUnixMs ?? null
    })),
    ...selectPendingActivations(state)
      .filter(
        (record) =>
          record.mode === "new" &&
          record.status !== "failed" &&
          !canonicalIds.has(record.agentSessionId)
      )
      .map((record) => ({
        id: record.agentSessionId,
        pinnedAtUnixMs: null,
        projectionSource: "pending_activation" as const
      }))
  ];
}

function pageState(page: {
  hasMore: boolean;
  nextCursor?: string | null;
  totalCount: number;
}): ConversationRailSectionPageState {
  return {
    hasMore: page.hasMore,
    isLoading: false,
    nextCursor: page.nextCursor ?? null,
    totalCount: page.totalCount
  };
}

function updateSectionPageState<T>(
  current: ReadonlyMap<string, T>,
  sectionId: string,
  value: T
): ReadonlyMap<string, T> {
  const next = new Map(current);
  next.set(sectionId, value);
  return next;
}
