import type {
  AgentConversationRailSessionPage,
  AgentConversationRailSessionSection
} from "../../../agentConversationRailContracts";
export {
  planRuntimeRailMembershipRefresh,
  type ConversationRailMembershipRecord,
  type ConversationRailMembershipRefreshPlan
} from "../model/agentGuiConversationRailMembershipRefresh";

export interface ConversationRailSectionPageState {
  hasMore: boolean;
  isLoading: boolean;
  nextCursor: string | null;
  totalCount: number;
}

export interface ConversationRailProjectSummary {
  createdAtUnixMs?: number;
  id: string;
  label: string;
  lastUsedAtUnixMs?: number;
  path: string;
  pinnedAtUnixMs: number;
  sectionKey?: string;
  updatedAtUnixMs?: number;
}

export interface ConversationRailSectionMembership {
  id: string;
  kind: "conversations" | "pinned" | "project";
  project: ConversationRailProjectSummary | null;
  sessionIds: readonly string[];
}

export interface ConversationRailQueryState {
  pending: boolean;
  reconcilingSessionIds: readonly string[];
  resolvedScopeKey: string | null;
  sectionPageStates: ReadonlyMap<string, ConversationRailSectionPageState>;
  sections: ConversationRailSectionMembership[] | null;
}

export function mergeConversationRailSessionIds(
  base: readonly string[],
  loaded: readonly string[]
): readonly string[] {
  const ids = new Set(base);
  const merged = [...base];
  for (const rawId of loaded) {
    const id = rawId.trim();
    if (!id || ids.has(id)) continue;
    ids.add(id);
    merged.push(id);
  }
  return merged;
}

export function projectRuntimeSectionsToConversationRailMemberships(input: {
  pinned?: AgentConversationRailSessionPage;
  sections: readonly AgentConversationRailSessionSection[];
}): ConversationRailSectionMembership[] {
  const result: ConversationRailSectionMembership[] = [];
  if (input.pinned && input.pinned.sessions.length > 0) {
    result.push({
      id: "pinned",
      kind: "pinned",
      project: null,
      sessionIds: input.pinned.sessions.map((session) => session.agentSessionId)
    });
  }
  for (const section of input.sections) {
    result.push({
      id: section.sectionKey,
      kind: section.kind,
      project: section.userProject ? { ...section.userProject } : null,
      sessionIds: section.sessions.map((session) => session.agentSessionId)
    });
  }
  return result;
}
