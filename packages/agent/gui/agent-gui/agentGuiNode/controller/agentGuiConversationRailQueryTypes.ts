import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { WorkspaceQueryCache } from "../../../shared/query/workspaceQueryCache";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGuiScheduler } from "../agentGuiScheduler";
import type { ConversationRailDiagnosticLogger } from "./agentGuiConversationRailDiagnostics";
import type { CachedConversationRailQuery } from "./agentGuiConversationRailQueryCache";
import { userProjectCollectionKey } from "./agentGuiConversationRailQueryScope";

export interface ConversationRailQueryScope {
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  previewMode: boolean;
  sectionAgentTargetFallbackId: string | null;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
}

export type ConversationRailQueryRuntime = Pick<
  AgentActivityRuntime,
  | "listPinnedSessionsPage"
  | "listSessionSectionPage"
  | "listSessionSections"
  | "listSessionsPage"
  | "getSessionSectionsQueryCache"
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
      scope.previewMode,
      agentTargetId,
      projectCollectionKey
    ])
  };
}
