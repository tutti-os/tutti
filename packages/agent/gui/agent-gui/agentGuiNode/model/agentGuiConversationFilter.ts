import type { AgentActivitySession } from "@tutti-os/agent-activity-core";
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
      conversation.provider,
      normalizedFilter
    )
  );
}

export function filterWorkspaceAgentActivitySessionsForConversations(
  sessions: readonly AgentActivitySession[],
  filter: AgentGUIConversationFilter
): AgentActivitySession[] {
  const normalizedFilter = normalizeAgentGUIConversationFilter(filter);
  return sessions.filter((session) =>
    matchesAgentGUIConversationFilterAgentTarget(
      session.agentTargetId,
      session.provider,
      normalizedFilter
    )
  );
}

export function matchesAgentGUIConversationSummaryFilter(
  conversation: {
    agentTargetId?: string | null;
    provider?: string | null;
  },
  filter: AgentGUIConversationFilter
): boolean {
  return matchesAgentGUIConversationFilterAgentTarget(
    conversation.agentTargetId,
    conversation.provider,
    normalizeAgentGUIConversationFilter(filter)
  );
}

function providerForLocalAgentTargetFilter(
  agentTargetId: string
): string | null {
  const normalized = agentTargetId.trim();
  if (!normalized.startsWith("local:")) {
    return null;
  }
  const provider = normalized.slice("local:".length).trim();
  return provider.length > 0 ? provider : null;
}

function matchesAgentGUIConversationFilterAgentTarget(
  agentTargetId: string | null | undefined,
  provider: string | null | undefined,
  filter: AgentGUIConversationFilter
): boolean {
  if (filter.kind === "all") {
    return true;
  }
  const sessionTargetId = agentTargetId?.trim() ?? "";
  if (sessionTargetId.length > 0) {
    return sessionTargetId === filter.agentTargetId;
  }
  const filterProvider = providerForLocalAgentTargetFilter(
    filter.agentTargetId
  );
  if (!filterProvider) {
    return false;
  }
  return (provider?.trim() ?? "") === filterProvider;
}
