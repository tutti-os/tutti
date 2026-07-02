import type { WorkspaceAgentActivitySession } from "../../../shared/workspaceAgentActivityTypes.ts";
import type { AgentGUIConversationSummary } from "./agentGuiConversationModel.ts";

export type AgentGUIConversationFilter =
  | {
      kind: "all";
    }
  | {
      kind: "agentTarget";
      agentTargetId: string;
    };

export interface AgentGUIConversationFilterState {
  filter: AgentGUIConversationFilter;
}

export function createAgentGUIConversationFilterState(
  filter: AgentGUIConversationFilter = { kind: "all" }
): AgentGUIConversationFilterState {
  return {
    filter: normalizeAgentGUIConversationFilter(filter)
  };
}

export function normalizeAgentGUIConversationFilter(
  filter: AgentGUIConversationFilter | null | undefined
): AgentGUIConversationFilter {
  if (filter?.kind === "agentTarget") {
    const agentTargetId = filter.agentTargetId?.trim() ?? "";
    return agentTargetId
      ? { kind: "agentTarget", agentTargetId }
      : { kind: "all" };
  }
  return { kind: "all" };
}

export function filterAgentGUIConversationSummaries(
  conversations: readonly AgentGUIConversationSummary[],
  filter: AgentGUIConversationFilter
): AgentGUIConversationSummary[] {
  const normalizedFilter = normalizeAgentGUIConversationFilter(filter);
  return conversations.filter((conversation) =>
    matchesAgentGUIConversationFilterAgentTarget(
      conversation.agentTargetId,
      normalizedFilter
    )
  );
}

export function filterWorkspaceAgentActivitySessionsForConversations(
  sessions: readonly WorkspaceAgentActivitySession[],
  filter: AgentGUIConversationFilter
): WorkspaceAgentActivitySession[] {
  const normalizedFilter = normalizeAgentGUIConversationFilter(filter);
  return sessions.filter((session) =>
    matchesAgentGUIConversationFilterAgentTarget(
      session.agentTargetId,
      normalizedFilter
    )
  );
}

function matchesAgentGUIConversationFilterAgentTarget(
  agentTargetId: string | null | undefined,
  filter: AgentGUIConversationFilter
): boolean {
  if (filter.kind === "all") {
    return true;
  }
  return (agentTargetId?.trim() ?? "") === filter.agentTargetId;
}
