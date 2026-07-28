import type { AgentConversationRailRuntimePort } from "./agentConversationRailContracts.ts";
const AGENT_CONVERSATION_BATCH_DELETION_RUNTIME_METHODS = [
  "deleteSessionsBatch",
  "listSessionSectionDeletionCandidates"
] as const satisfies ReadonlyArray<keyof AgentConversationRailRuntimePort>;

const AGENT_CONVERSATION_RAIL_SOURCE_METHODS = [
  "deleteSessionsBatch",
  "listPinnedSessionsPage",
  "listSessionSectionDeletionCandidates",
  "listSessionSectionPage",
  "listSessionSections",
  "listSessionsPage"
] as const satisfies ReadonlyArray<keyof AgentConversationRailRuntimePort>;

export const AGENT_CONVERSATION_RAIL_RUNTIME_METHODS = [
  ...AGENT_CONVERSATION_RAIL_SOURCE_METHODS
] as const satisfies ReadonlyArray<keyof AgentConversationRailRuntimePort>;

type AgentConversationRailSourceMethod =
  (typeof AGENT_CONVERSATION_RAIL_SOURCE_METHODS)[number];
type AgentConversationBatchDeletionRuntimeMethod =
  (typeof AGENT_CONVERSATION_BATCH_DELETION_RUNTIME_METHODS)[number];

export type AgentConversationRailRuntime = Required<
  Pick<
    AgentConversationRailRuntimePort,
    (typeof AGENT_CONVERSATION_RAIL_RUNTIME_METHODS)[number]
  >
>;

export type AgentConversationRailRuntimeSource = Required<
  Pick<AgentConversationRailRuntimePort, AgentConversationRailSourceMethod>
>;

export interface AgentConversationBatchDeletionCapability {
  available: boolean;
  missingMethods: AgentConversationBatchDeletionRuntimeMethod[];
  partial: boolean;
}

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

export function inspectAgentConversationBatchDeletionCapability(
  runtime: Partial<
    Pick<
      AgentConversationRailRuntimePort,
      AgentConversationBatchDeletionRuntimeMethod
    >
  >
): AgentConversationBatchDeletionCapability {
  const missingMethods =
    AGENT_CONVERSATION_BATCH_DELETION_RUNTIME_METHODS.filter(
      (method) => typeof runtime[method] !== "function"
    );
  return {
    available: missingMethods.length === 0,
    missingMethods: [...missingMethods],
    partial:
      missingMethods.length > 0 &&
      missingMethods.length <
        AGENT_CONVERSATION_BATCH_DELETION_RUNTIME_METHODS.length
  };
}
