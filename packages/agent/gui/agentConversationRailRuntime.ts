import type { AgentActivityRuntime } from "./agentActivityRuntime.tsx";
import {
  createWorkspaceQueryCache,
  type WorkspaceQueryCache
} from "./shared/query/workspaceQueryCache.ts";

const AGENT_CONVERSATION_BATCH_DELETION_RUNTIME_METHODS = [
  "deleteSessionsBatch",
  "listSessionSectionDeletionCandidates"
] as const satisfies ReadonlyArray<keyof AgentActivityRuntime>;

const AGENT_CONVERSATION_RAIL_SOURCE_METHODS = [
  "deleteSessionsBatch",
  "listPinnedSessionsPage",
  "listSessionSectionDeletionCandidates",
  "listSessionSectionPage",
  "listSessionSections",
  "listSessionsPage"
] as const satisfies ReadonlyArray<keyof AgentActivityRuntime>;

export const AGENT_CONVERSATION_RAIL_RUNTIME_METHODS = [
  "getSessionSectionsQueryCache",
  ...AGENT_CONVERSATION_RAIL_SOURCE_METHODS
] as const satisfies ReadonlyArray<keyof AgentActivityRuntime>;

type AgentConversationRailSourceMethod =
  (typeof AGENT_CONVERSATION_RAIL_SOURCE_METHODS)[number];
type AgentConversationBatchDeletionRuntimeMethod =
  (typeof AGENT_CONVERSATION_BATCH_DELETION_RUNTIME_METHODS)[number];

export type AgentConversationRailRuntime = Required<
  Pick<
    AgentActivityRuntime,
    (typeof AGENT_CONVERSATION_RAIL_RUNTIME_METHODS)[number]
  >
>;

export type AgentConversationRailRuntimeSource = Required<
  Pick<AgentActivityRuntime, AgentConversationRailSourceMethod>
>;

export interface AgentConversationBatchDeletionCapability {
  available: boolean;
  missingMethods: AgentConversationBatchDeletionRuntimeMethod[];
  partial: boolean;
}

export function createAgentConversationRailRuntime(
  source: AgentConversationRailRuntimeSource
): AgentConversationRailRuntime {
  const sessionSectionsQueryCaches = new Map<
    string,
    WorkspaceQueryCache<unknown>
  >();

  return {
    deleteSessionsBatch: (input) => source.deleteSessionsBatch(input),
    getSessionSectionsQueryCache(workspaceId) {
      const key = workspaceId.trim();
      const current = sessionSectionsQueryCaches.get(key);
      if (current) return current;
      const created = createWorkspaceQueryCache<unknown>();
      sessionSectionsQueryCaches.set(key, created);
      return created;
    },
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
    Pick<AgentActivityRuntime, AgentConversationBatchDeletionRuntimeMethod>
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
