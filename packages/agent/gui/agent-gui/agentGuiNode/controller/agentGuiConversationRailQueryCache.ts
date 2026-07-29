import type {
  AgentConversationRailSessionPage,
  AgentConversationRailSessionSection,
  AgentConversationRailSessionSectionsResult
} from "../../../agentConversationRailContracts";
import type {
  WorkspaceQueryCache,
  WorkspaceQueryCacheEntry
} from "../../../shared/query/workspaceQueryCache";
import {
  mergeConversationRailSessionIds,
  projectRuntimeSectionsToConversationRailMemberships,
  type ConversationRailQueryState,
  type ConversationRailSectionMembership,
  type ConversationRailSectionPageState
} from "./agentConversationRailQueryModel";

export interface CachedConversationRailQuery {
  queryState: ConversationRailQueryState;
  returnedSessionCount: number;
  sectionCount: number;
}

export type ConversationRailRefreshedPage =
  | { kind: "pinned"; page: AgentConversationRailSessionPage }
  | {
      id: string;
      kind: "section";
      page: AgentConversationRailSessionSection;
    };

export function cachedConversationRailQueryFromFirstPages(
  page: AgentConversationRailSessionSectionsResult,
  scopeKey: string,
  currentQueryState?: ConversationRailQueryState
): CachedConversationRailQuery {
  const freshSections = projectRuntimeSectionsToConversationRailMemberships({
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
  const { sections, states } = preserveLoadedConversationRailTails({
    currentQueryState,
    freshSections,
    freshPageStates: sectionPageStates
  });
  return {
    queryState: {
      pending: false,
      reconcilingSessionIds: [],
      resolvedScopeKey: scopeKey,
      sectionPageStates: states,
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

function preserveLoadedConversationRailTails(input: {
  currentQueryState?: ConversationRailQueryState;
  freshPageStates: ReadonlyMap<string, ConversationRailSectionPageState>;
  freshSections: readonly ConversationRailSectionMembership[];
}): {
  sections: ConversationRailSectionMembership[];
  states: ReadonlyMap<string, ConversationRailSectionPageState>;
} {
  const currentSections = input.currentQueryState?.sections;
  if (!currentSections?.length) {
    return {
      sections: [...input.freshSections],
      states: input.freshPageStates
    };
  }
  const freshOwnerBySessionId = new Map<string, string>();
  for (const section of input.freshSections) {
    for (const sessionId of section.sessionIds) {
      freshOwnerBySessionId.set(sessionId, section.id);
    }
  }
  let states = input.freshPageStates;
  const sections = input.freshSections.map((section) => {
    const previous = currentSections.find(
      (candidate) => candidate.id === section.id
    );
    const freshState = states.get(section.id);
    if (!freshState) return section;
    const preserved = preserveConversationRailMembershipTail({
      freshOwnerBySessionId,
      freshSection: section,
      freshState,
      previousSection: previous,
      previousState: input.currentQueryState?.sectionPageStates.get(section.id)
    });
    states = updateConversationRailSectionPageState(
      states,
      section.id,
      preserved.state
    );
    return preserved.section;
  });
  return { sections, states };
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
  const refreshedSections = input.pages.map((refreshed) => {
    const sectionId = refreshed.kind === "pinned" ? "pinned" : refreshed.id;
    const projected =
      refreshed.kind === "pinned"
        ? projectRuntimeSectionsToConversationRailMemberships({
            pinned: refreshed.page,
            sections: []
          })[0]
        : projectRuntimeSectionsToConversationRailMemberships({
            sections: [refreshed.page]
          })[0];
    return {
      freshState: conversationRailPageState(refreshed.page),
      projected,
      sectionId
    };
  });
  const freshOwnerBySessionId = new Map<string, string>();
  for (const refreshed of refreshedSections) {
    for (const sessionId of refreshed.projected?.sessionIds ?? []) {
      freshOwnerBySessionId.set(sessionId, refreshed.sectionId);
    }
  }
  for (const refreshed of refreshedSections) {
    const { freshState, projected, sectionId } = refreshed;
    sectionPageStates = updateConversationRailSectionPageState(
      sectionPageStates,
      sectionId,
      freshState
    );
    const existingIndex = sections.findIndex(
      (section) => section.id === sectionId
    );
    if (!projected) {
      if (existingIndex >= 0) sections.splice(existingIndex, 1);
      continue;
    }
    const preserved = preserveConversationRailMembershipTail({
      freshOwnerBySessionId,
      freshSection: projected,
      freshState,
      previousSection: existingIndex >= 0 ? sections[existingIndex] : undefined,
      previousState: input.queryState.sectionPageStates.get(sectionId)
    });
    sectionPageStates = updateConversationRailSectionPageState(
      sectionPageStates,
      sectionId,
      preserved.state
    );
    if (existingIndex >= 0) {
      sections[existingIndex] = preserved.section;
      continue;
    }
    if (preserved.section.kind === "pinned") {
      sections.unshift(preserved.section);
      continue;
    }
    const conversationsIndex = sections.findIndex(
      (section) => section.kind === "conversations"
    );
    if (preserved.section.kind === "project" && conversationsIndex >= 0) {
      sections.splice(conversationsIndex, 0, preserved.section);
    } else {
      sections.push(preserved.section);
    }
  }
  return {
    ...input.queryState,
    reconcilingSessionIds: [],
    sectionPageStates,
    sections
  };
}

function preserveConversationRailMembershipTail(input: {
  freshOwnerBySessionId: ReadonlyMap<string, string>;
  freshSection: ConversationRailSectionMembership;
  freshState: ConversationRailSectionPageState;
  previousSection?: ConversationRailSectionMembership;
  previousState?: ConversationRailSectionPageState;
}): {
  section: ConversationRailSectionMembership;
  state: ConversationRailSectionPageState;
} {
  if (
    !input.previousSection ||
    input.previousSection.sessionIds.length <=
      input.freshSection.sessionIds.length
  ) {
    return { section: input.freshSection, state: input.freshState };
  }
  const freshIds = new Set(input.freshSection.sessionIds);
  const preservedTail = input.previousSection.sessionIds.filter(
    (sessionId) =>
      !freshIds.has(sessionId) && !input.freshOwnerBySessionId.has(sessionId)
  );
  const sessionIds = [...input.freshSection.sessionIds, ...preservedTail].slice(
    0,
    input.freshState.totalCount
  );
  const hasMore = sessionIds.length < input.freshState.totalCount;
  return {
    section: { ...input.freshSection, sessionIds },
    state: {
      ...input.freshState,
      hasMore,
      nextCursor: hasMore
        ? (input.previousState?.nextCursor ?? input.freshState.nextCursor)
        : null
    }
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
  page: AgentConversationRailSessionPage;
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
