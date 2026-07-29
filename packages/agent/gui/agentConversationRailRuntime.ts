import type { AgentConversationRailRuntimePort } from "./agentConversationRailContracts.ts";

type AgentConversationRailRuntimeMethod =
  | "deleteSessionsBatch"
  | "listPinnedSessionsPage"
  | "listSessionSectionDeletionCandidates"
  | "listSessionSectionPage"
  | "listSessionSections"
  | "listSessionsPage";

export type AgentConversationRailRuntime = Required<
  Pick<AgentConversationRailRuntimePort, AgentConversationRailRuntimeMethod>
>;

export type AgentConversationRailRuntimeSource = Required<
  Pick<AgentConversationRailRuntimePort, AgentConversationRailRuntimeMethod>
>;

export function createAgentConversationRailRuntime(
  source: AgentConversationRailRuntimeSource
): AgentConversationRailRuntime {
  return {
    deleteSessionsBatch: (input) => source.deleteSessionsBatch(input),
    listPinnedSessionsPage: (input) => source.listPinnedSessionsPage(input),
    listSessionSectionDeletionCandidates: (input) =>
      source.listSessionSectionDeletionCandidates(input),
    listSessionSectionPage: (input) => source.listSessionSectionPage(input),
    listSessionSections: (input) => source.listSessionSections(input),
    listSessionsPage: (input) => source.listSessionsPage(input)
  };
}
