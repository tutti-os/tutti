import type { AgentConversationRailRuntimePort } from "../../../agentConversationRailContracts.ts";

const AGENT_CONVERSATION_BATCH_DELETION_RUNTIME_METHODS = [
  "deleteSessionsBatch",
  "listSessionSectionDeletionCandidates"
] as const satisfies ReadonlyArray<keyof AgentConversationRailRuntimePort>;

type AgentConversationBatchDeletionRuntimeMethod =
  (typeof AGENT_CONVERSATION_BATCH_DELETION_RUNTIME_METHODS)[number];

export interface AgentConversationBatchDeletionCapability {
  available: boolean;
  missingMethods: AgentConversationBatchDeletionRuntimeMethod[];
  partial: boolean;
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
