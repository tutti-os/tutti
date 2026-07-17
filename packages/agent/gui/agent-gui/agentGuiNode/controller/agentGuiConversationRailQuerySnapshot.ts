import type {
  ConversationRailQueryState,
  ConversationRailSectionMembership
} from "../model/agentGuiConversationRail";
import {
  selectWorkspaceAgentConsumerSessions,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { projectCanonicalAgentGUIConversationSummaries } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import { createAgentGUIConversationRailTitlePromptSelector } from "../../../shared/agentConversationRailTitlePromptSelector";
import {
  conversationSummariesRenderEqual,
  mergeConversationRailSessionIds
} from "../model/agentGuiConversationRail";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";

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
  runtimeRailConversations: AgentGUIConversationSummary[];
  runtimeRailReconcilingSessionIds: readonly string[];
  runtimeRailSectionsPending: boolean;
  sectionPageStates: ConversationRailQueryState["sectionPageStates"];
}

export function buildConversationRailQuerySnapshot(input: {
  queryState: ConversationRailQueryState;
  runtimeRailConversations: AgentGUIConversationSummary[];
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
    runtimeRailConversations: input.runtimeRailConversations,
    runtimeRailReconcilingSessionIds: input.queryState.reconcilingSessionIds,
    runtimeRailSectionsPending: input.queryState.pending,
    sectionPageStates: input.queryState.sectionPageStates
  };
}

export function createConversationRailQuerySnapshotSelector(): (
  input: Omit<
    Parameters<typeof buildConversationRailQuerySnapshot>[0],
    "runtimeRailConversations"
  > & { engineState: AgentSessionEngineState },
  previous: AgentGUIConversationRailQuerySnapshot | undefined,
  force?: boolean
) => AgentGUIConversationRailQuerySnapshot {
  const selectRailTitlePrompts =
    createAgentGUIConversationRailTitlePromptSelector();
  return (input, previous, force = false) => {
    const runtimeRailConversations =
      projectCanonicalAgentGUIConversationSummaries(
        selectWorkspaceAgentConsumerSessions(input.engineState),
        selectRailTitlePrompts(input.engineState)
      );
    if (
      !force &&
      previous?.runtimeRailConversations.length ===
        runtimeRailConversations.length &&
      previous.runtimeRailConversations.every((conversation, index) =>
        conversationSummariesRenderEqual(
          conversation,
          runtimeRailConversations[index]!
        )
      )
    ) {
      return previous;
    }
    return buildConversationRailQuerySnapshot({
      ...input,
      runtimeRailConversations
    });
  };
}
