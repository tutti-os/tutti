import type { AgentActivitySession } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntimeSessionSectionsResult } from "../../../agentActivityRuntime";
import type {
  WorkspaceQueryCache,
  WorkspaceQueryCacheEntry
} from "../../../shared/query/workspaceQueryCache";
import {
  projectRuntimeSectionsToConversationRailMemberships,
  type ConversationRailQueryState,
  type ConversationRailSectionPageState
} from "../model/agentGuiConversationRail";

export interface CachedConversationRailQuery {
  queryState: ConversationRailQueryState;
  returnedSessionCount: number;
  sectionCount: number;
  sessions: readonly AgentActivitySession[];
}

export function cachedConversationRailQueryFromFirstPages(
  page: AgentActivityRuntimeSessionSectionsResult,
  scopeKey: string
): CachedConversationRailQuery {
  const sections = projectRuntimeSectionsToConversationRailMemberships({
    pinned: page.pinned,
    sections: page.sections
  });
  const sectionPageStates = new Map<string, ConversationRailSectionPageState>();
  if (page.pinned) {
    sectionPageStates.set("pinned", conversationRailPageState(page.pinned));
  }
  for (const section of page.sections) {
    sectionPageStates.set(
      section.sectionKey,
      conversationRailPageState(section)
    );
  }
  const sessions = [
    ...(page.pinned?.sessions ?? []),
    ...page.sections.flatMap((section) => section.sessions)
  ];
  return {
    queryState: {
      pending: false,
      reconcilingSessionIds: [],
      resolvedScopeKey: scopeKey,
      sectionPageStates,
      sections
    },
    returnedSessionCount: sessions.length,
    sectionCount: page.sections.length + (page.pinned ? 1 : 0),
    sessions
  };
}

export function applyCachedConversationRailQuery(input: {
  cache: WorkspaceQueryCache<CachedConversationRailQuery>;
  entry: WorkspaceQueryCacheEntry<CachedConversationRailQuery>;
  scopeKey: string;
  upsertSessions(sessions: readonly AgentActivitySession[]): void;
}): ConversationRailQueryState {
  if (input.cache.claimIngestion(input.scopeKey, input.entry.version)) {
    input.upsertSessions(input.entry.value.sessions);
  }
  return input.entry.value.queryState;
}

export function writeConversationRailQueryCache(input: {
  cache: WorkspaceQueryCache<CachedConversationRailQuery>;
  queryState: ConversationRailQueryState;
  scopeKey: string | null;
}): void {
  const { queryState, scopeKey } = input;
  if (
    !scopeKey ||
    queryState.pending ||
    queryState.resolvedScopeKey !== scopeKey ||
    queryState.sections === null
  ) {
    return;
  }
  input.cache.write(scopeKey, {
    queryState,
    returnedSessionCount: queryState.sections.reduce(
      (count, section) => count + section.sessionIds.length,
      0
    ),
    sectionCount: queryState.sections.length,
    sessions: []
  });
}

export function updateConversationRailSectionPageState<T>(
  current: ReadonlyMap<string, T>,
  sectionId: string,
  value: T
): ReadonlyMap<string, T> {
  const next = new Map(current);
  next.set(sectionId, value);
  return next;
}

function conversationRailPageState(page: {
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
