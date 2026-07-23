import type {
  AgentActivityRuntimeSessionPage,
  AgentActivityRuntimeSessionSection,
  AgentActivityRuntimeSessionSectionsResult
} from "../../../agentActivityRuntime";
import type {
  WorkspaceQueryCache,
  WorkspaceQueryCacheEntry
} from "../../../shared/query/workspaceQueryCache";
import {
  mergeConversationRailSessionIds,
  projectRuntimeSectionsToConversationRailMemberships,
  type ConversationRailQueryState,
  type ConversationRailSectionPageState
} from "../model/agentGuiConversationRail";

export interface CachedConversationRailQuery {
  queryState: ConversationRailQueryState;
  returnedSessionCount: number;
  sectionCount: number;
}

export type ConversationRailRefreshedPage =
  | { kind: "pinned"; page: AgentActivityRuntimeSessionPage }
  | {
      id: string;
      kind: "section";
      page: AgentActivityRuntimeSessionSection;
    };

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
  return {
    queryState: {
      pending: false,
      reconcilingSessionIds: [],
      resolvedScopeKey: scopeKey,
      sectionPageStates,
      sections
    },
    returnedSessionCount:
      (page.pinned?.sessions.length ?? 0) +
      page.sections.reduce(
        (count, section) => count + section.sessions.length,
        0
      ),
    sectionCount: page.sections.length + (page.pinned ? 1 : 0)
  };
}

export function applyCachedConversationRailQuery(input: {
  entry: WorkspaceQueryCacheEntry<CachedConversationRailQuery>;
}): ConversationRailQueryState {
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
    sectionCount: queryState.sections.length
  });
}

export function replaceConversationRailFirstPages(input: {
  pages: readonly ConversationRailRefreshedPage[];
  queryState: ConversationRailQueryState;
}): ConversationRailQueryState {
  let sections = [...(input.queryState.sections ?? [])];
  let sectionPageStates = input.queryState.sectionPageStates;
  for (const refreshed of input.pages) {
    const sectionId = refreshed.kind === "pinned" ? "pinned" : refreshed.id;
    sectionPageStates = updateConversationRailSectionPageState(
      sectionPageStates,
      sectionId,
      conversationRailPageState(refreshed.page)
    );
    const projected =
      refreshed.kind === "pinned"
        ? projectRuntimeSectionsToConversationRailMemberships({
            pinned: refreshed.page,
            sections: []
          })[0]
        : projectRuntimeSectionsToConversationRailMemberships({
            sections: [refreshed.page]
          })[0];
    const existingIndex = sections.findIndex(
      (section) => section.id === sectionId
    );
    if (!projected) {
      if (existingIndex >= 0) sections.splice(existingIndex, 1);
      continue;
    }
    if (existingIndex >= 0) {
      sections[existingIndex] = projected;
      continue;
    }
    if (projected.kind === "pinned") {
      sections.unshift(projected);
      continue;
    }
    const conversationsIndex = sections.findIndex(
      (section) => section.kind === "conversations"
    );
    if (projected.kind === "project" && conversationsIndex >= 0) {
      sections.splice(conversationsIndex, 0, projected);
    } else {
      sections.push(projected);
    }
  }
  return {
    ...input.queryState,
    reconcilingSessionIds: [],
    sectionPageStates,
    sections
  };
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

export function appendConversationRailSectionPage(input: {
  page: AgentActivityRuntimeSessionPage;
  queryState: ConversationRailQueryState;
  sectionId: string;
}): ConversationRailQueryState {
  return {
    ...input.queryState,
    sectionPageStates: updateConversationRailSectionPageState(
      input.queryState.sectionPageStates,
      input.sectionId,
      conversationRailPageState(input.page)
    ),
    sections:
      input.queryState.sections?.map((section) =>
        section.id === input.sectionId
          ? {
              ...section,
              sessionIds: mergeConversationRailSessionIds(
                section.sessionIds,
                input.page.sessions.map((session) => session.agentSessionId)
              )
            }
          : section
      ) ?? null
  };
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
