import type { AgentGUIConversationFilter } from "./agentGuiConversationFilter";

export const AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE = 5;

export type AgentGUIConversationRailRevealReason = "created" | "external-open";

export interface AgentGUIConversationRailRevealRequest {
  agentSessionId: string;
  reason: AgentGUIConversationRailRevealReason;
  revision: number;
}

export interface AgentGUIConversationRailScopedViewState {
  collapsedSectionIds: ReadonlySet<string>;
  visibleItemLimitBySectionId: ReadonlyMap<string, number>;
}

export type AgentGUIConversationRailViewState = ReadonlyMap<
  string,
  AgentGUIConversationRailScopedViewState
>;

export type AgentGUIConversationRailViewStateAction =
  | { scopeKey: string; sectionId: string; type: "section-collapsed-toggled" }
  | {
      limit: number;
      scopeKey: string;
      sectionId: string;
      type: "section-visible-limit-set";
    };

const EMPTY_SCOPED_RAIL_VIEW_STATE: AgentGUIConversationRailScopedViewState = {
  collapsedSectionIds: new Set(),
  visibleItemLimitBySectionId: new Map()
};

export function agentGUIConversationRailViewScopeKey(input: {
  conversationFilter: AgentGUIConversationFilter;
  sectionAgentTargetFallbackId: string | null;
  workspaceId: string;
}): string {
  const filterScope =
    input.conversationFilter.kind === "agentTarget"
      ? `agentTarget:${input.conversationFilter.agentTargetId.trim()}`
      : `all:${input.sectionAgentTargetFallbackId?.trim() ?? ""}`;
  return `${input.workspaceId.trim()}:${filterScope}`;
}

export function agentGUIConversationRailScopedViewState(
  state: AgentGUIConversationRailViewState,
  scopeKey: string
): AgentGUIConversationRailScopedViewState {
  return state.get(scopeKey) ?? EMPTY_SCOPED_RAIL_VIEW_STATE;
}

export function reduceAgentGUIConversationRailViewState(
  state: AgentGUIConversationRailViewState,
  action: AgentGUIConversationRailViewStateAction
): AgentGUIConversationRailViewState {
  const current = agentGUIConversationRailScopedViewState(
    state,
    action.scopeKey
  );
  if (action.type === "section-collapsed-toggled") {
    const collapsedSectionIds = new Set(current.collapsedSectionIds);
    if (collapsedSectionIds.has(action.sectionId)) {
      collapsedSectionIds.delete(action.sectionId);
    } else {
      collapsedSectionIds.add(action.sectionId);
    }
    const next = new Map(state);
    next.set(action.scopeKey, { ...current, collapsedSectionIds });
    return next;
  }
  const limit = Math.max(
    AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
    Math.floor(action.limit)
  );
  if (
    (current.visibleItemLimitBySectionId.get(action.sectionId) ??
      AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE) === limit
  ) {
    return state;
  }
  const visibleItemLimitBySectionId = new Map(
    current.visibleItemLimitBySectionId
  );
  visibleItemLimitBySectionId.set(action.sectionId, limit);
  const next = new Map(state);
  next.set(action.scopeKey, { ...current, visibleItemLimitBySectionId });
  return next;
}
