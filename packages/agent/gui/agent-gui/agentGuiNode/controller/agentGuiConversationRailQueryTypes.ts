import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentConversationRailRuntimePort } from "../../../agentConversationRailContracts";
import type { WorkspaceQueryCache } from "../../../shared/query/workspaceQueryCache";
import type { AgentGuiScheduler } from "../agentGuiScheduler";
import type { ConversationRailDiagnosticLogger } from "./agentGuiConversationRailDiagnostics";
import type { CachedConversationRailQuery } from "./agentGuiConversationRailQueryCache";
import { userProjectCollectionKey } from "./agentGuiConversationRailQueryScope";

export interface ConversationRailQueryScope {
  conversationFilter:
    | { kind: "all" }
    | { agentTargetId: string; kind: "agentTarget" };
  sectionAgentTargetFallbackId: string | null;
  userProjects: readonly { id: string }[];
}

export type ConversationRailQueryRuntime = Pick<
  AgentConversationRailRuntimePort,
  | "listPinnedSessionsPage"
  | "listSessionSectionPage"
  | "listSessionSections"
  | "listSessionsPage"
  | "reportDiagnostic"
>;

export interface ConversationRailQueryControllerInput {
  cacheNow?: () => number;
  cacheFreshMs?: number;
  diagnosticLogger?: ConversationRailDiagnosticLogger;
  diagnosticNow?: () => number;
  diagnosticSlowThresholdMs?: number;
  engine: AgentSessionEngine;
  getActiveConversationId(): string | null;
  nodeId?: string | null;
  runtime: ConversationRailQueryRuntime;
  sectionPageSize?: number;
  sectionRefreshLimitMax?: number;
  sessionSectionsQueryCache?: WorkspaceQueryCache<CachedConversationRailQuery>;
  scheduler?: AgentGuiScheduler;
  workspaceId: string;
}

export function resolveConversationRailQueryScope(
  workspaceId: string,
  scope: ConversationRailQueryScope
): { scopeKey: string; agentTargetId: string } {
  const agentTargetId =
    scope.conversationFilter.kind === "agentTarget"
      ? scope.conversationFilter.agentTargetId.trim()
      : (scope.sectionAgentTargetFallbackId?.trim() ?? "");
  const projectCollectionKey = userProjectCollectionKey(scope.userProjects);
  return {
    agentTargetId,
    scopeKey: JSON.stringify([
      workspaceId,
      scope.conversationFilter.kind === "agentTarget"
        ? `agentTarget:${scope.conversationFilter.agentTargetId.trim()}`
        : "all",
      agentTargetId,
      projectCollectionKey
    ])
  };
}
