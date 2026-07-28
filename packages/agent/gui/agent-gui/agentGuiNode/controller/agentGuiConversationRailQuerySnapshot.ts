import type {
  ConversationRailQueryState,
  ConversationRailSectionMembership
} from "../model/agentGuiConversationRail";
import {
  selectWorkspaceAgentConsumerSessions,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { projectCanonicalAgentGUIConversationSummaries } from "../../../shared/agentGUIConversationSummaryProjection";
import { createAgentGUIConversationRailTitlePromptSelector } from "../../../shared/agentConversationRailTitlePromptSelector";
import {
  mergeConversationRailSessionIds,
  stabilizeConversationSectionItems
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
  runtimeRailResolvedScopeKey: string | null;
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
    runtimeRailResolvedScopeKey: input.queryState.resolvedScopeKey,
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
    const workspaceSessions = selectWorkspaceAgentConsumerSessions(
      input.engineState
    );
    const projectionSessionIds = new Set<string>();
    if (!input.runtimeSectionsEnabled) {
      for (const session of workspaceSessions) {
        projectionSessionIds.add(session.session.agentSessionId);
      }
    }
    for (const section of input.queryState.sections ?? []) {
      for (const sessionId of section.sessionIds) {
        projectionSessionIds.add(sessionId);
      }
    }
    for (const sessionId of input.queryState.reconcilingSessionIds) {
      projectionSessionIds.add(sessionId);
    }
    if (
      input.searchEnabled &&
      input.searchState.requestKey === input.searchRequestKey &&
      input.searchState.resolvedQuery === input.searchQuery
    ) {
      for (const sessionId of input.searchState.sessionIds) {
        projectionSessionIds.add(sessionId);
      }
    }
    const projectedRailConversations =
      projectCanonicalAgentGUIConversationSummaries(
        workspaceSessions.filter((session) =>
          projectionSessionIds.has(session.session.agentSessionId)
        ),
        selectRailTitlePrompts(input.engineState)
      );
    const runtimeRailConversations = stabilizeConversationSectionItems(
      previous?.runtimeRailConversations ?? [],
      projectedRailConversations
    );
    if (
      !force &&
      previous?.runtimeRailConversations === runtimeRailConversations
    ) {
      return previous;
    }
    return buildConversationRailQuerySnapshot({
      ...input,
      runtimeRailConversations
    });
  };
}
