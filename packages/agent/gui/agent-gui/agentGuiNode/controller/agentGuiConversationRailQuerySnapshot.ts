import type {
  ConversationRailQueryState,
  ConversationRailSectionMembership
} from "../model/agentGuiConversationRail";

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

export function buildConversationRailQuerySnapshot(input: {
  queryState: ConversationRailQueryState;
  runtimeSectionsEnabled: boolean;
  searchEnabled: boolean;
  searchQuery: string;
  searchRequestKey: string | null;
  searchState: ConversationSearchQueryState;
}): AgentGUIConversationRailQuerySnapshot {
  const searchResolved =
    input.searchState.requestKey === input.searchRequestKey &&
    input.searchState.resolvedQuery === input.searchQuery;
  return {
    railSearch: {
      enabled: input.searchEnabled,
      failed: searchResolved && input.searchState.failed,
      hasMore: searchResolved && input.searchState.hasMore,
      loadingMore: searchResolved && input.searchState.loadingMore,
      pending:
        Boolean(input.searchQuery) &&
        (!searchResolved || input.searchState.pending),
      resolvedQuery: searchResolved ? input.searchState.resolvedQuery : "",
      sessionIds: searchResolved ? input.searchState.sessionIds : []
    },
    runtimeSectionsEnabled: input.runtimeSectionsEnabled,
    runtimeRailMemberships: input.queryState.sections,
    runtimeRailReconcilingSessionIds: input.queryState.reconcilingSessionIds,
    runtimeRailSectionsPending: input.queryState.pending,
    sectionPageStates: input.queryState.sectionPageStates
  };
}
