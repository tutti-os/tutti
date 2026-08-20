import {
  mergeConversationRailSessionIds,
  type ConversationRailQueryState
} from "./agentConversationRailQueryModel";

export const EMPTY_CONVERSATION_RAIL_QUERY_STATE: ConversationRailQueryState = {
  pending: false,
  reconcilingSessionIds: [],
  resolvedScopeKey: null,
  sectionPageStates: new Map(),
  sections: null
};

export interface ConversationSearchQueryState {
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  pending: boolean;
  requestKey: string | null;
  resolvedQuery: string;
  sessionIds: readonly string[];
}

export const EMPTY_CONVERSATION_SEARCH_QUERY_STATE: ConversationSearchQueryState =
  {
    failed: false,
    hasMore: false,
    loadingMore: false,
    nextCursor: null,
    pending: false,
    requestKey: null,
    resolvedQuery: "",
    sessionIds: []
  };

export function appendConversationSearchPage(
  state: ConversationSearchQueryState,
  page: {
    hasMore: boolean;
    nextCursor?: string | null;
    sessions: readonly { agentSessionId: string }[];
  }
): ConversationSearchQueryState {
  return {
    ...state,
    failed: false,
    hasMore: page.hasMore,
    loadingMore: false,
    nextCursor: page.nextCursor ?? null,
    sessionIds: mergeConversationRailSessionIds(
      state.sessionIds,
      page.sessions.map((session) => session.agentSessionId)
    )
  };
}

export interface AgentGUIConversationRailQuerySnapshot {
  agentTargetId: string;
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
  runtimeRailFailed: boolean;
  runtimeRailMemberships: ConversationRailQueryState["sections"];
  runtimeRailReconcilingSessionIds: readonly string[];
  runtimeRailResolvedScopeKey: string | null;
  runtimeRailSectionsPending: boolean;
  sectionPageStates: ConversationRailQueryState["sectionPageStates"];
}

export function createConversationRailQuerySnapshotSelector(): (
  input: {
    agentTargetId?: string | null;
    queryState: ConversationRailQueryState;
    runtimeRailFailed: boolean;
    runtimeSectionsEnabled: boolean;
    searchEnabled: boolean;
    searchQuery: string;
    searchRequestKey: string | null;
    searchState: ConversationSearchQueryState;
  },
  previous: AgentGUIConversationRailQuerySnapshot | undefined,
  force?: boolean
) => AgentGUIConversationRailQuerySnapshot {
  return (input, previous, force = false) => {
    const searchResolved =
      input.searchState.requestKey === input.searchRequestKey &&
      input.searchState.resolvedQuery === input.searchQuery;
    const next: AgentGUIConversationRailQuerySnapshot = {
      agentTargetId: input.agentTargetId?.trim() ?? "",
      railSearch: {
        enabled: input.searchEnabled,
        failed: searchResolved && input.searchState.failed,
        hasMore: searchResolved && input.searchState.hasMore,
        loadingMore: searchResolved && input.searchState.loadingMore,
        pending:
          input.searchEnabled &&
          Boolean(input.searchQuery) &&
          (!searchResolved || input.searchState.pending),
        resolvedQuery: searchResolved ? input.searchState.resolvedQuery : "",
        sessionIds: searchResolved
          ? input.searchState.sessionIds
          : EMPTY_CONVERSATION_SEARCH_QUERY_STATE.sessionIds
      },
      runtimeSectionsEnabled: input.runtimeSectionsEnabled,
      runtimeRailFailed: input.runtimeRailFailed,
      runtimeRailMemberships: input.queryState.sections,
      runtimeRailReconcilingSessionIds: input.queryState.reconcilingSessionIds,
      runtimeRailResolvedScopeKey: input.queryState.resolvedScopeKey,
      runtimeRailSectionsPending: input.queryState.pending,
      sectionPageStates: input.queryState.sectionPageStates
    };
    return !force && previous && sameSnapshot(previous, next) ? previous : next;
  };
}

function sameSnapshot(
  left: AgentGUIConversationRailQuerySnapshot,
  right: AgentGUIConversationRailQuerySnapshot
): boolean {
  return (
    left.agentTargetId === right.agentTargetId &&
    left.runtimeSectionsEnabled === right.runtimeSectionsEnabled &&
    left.runtimeRailFailed === right.runtimeRailFailed &&
    left.runtimeRailMemberships === right.runtimeRailMemberships &&
    left.runtimeRailReconcilingSessionIds ===
      right.runtimeRailReconcilingSessionIds &&
    left.runtimeRailResolvedScopeKey === right.runtimeRailResolvedScopeKey &&
    left.runtimeRailSectionsPending === right.runtimeRailSectionsPending &&
    left.sectionPageStates === right.sectionPageStates &&
    left.railSearch.enabled === right.railSearch.enabled &&
    left.railSearch.failed === right.railSearch.failed &&
    left.railSearch.hasMore === right.railSearch.hasMore &&
    left.railSearch.loadingMore === right.railSearch.loadingMore &&
    left.railSearch.pending === right.railSearch.pending &&
    left.railSearch.resolvedQuery === right.railSearch.resolvedQuery &&
    left.railSearch.sessionIds === right.railSearch.sessionIds
  );
}
