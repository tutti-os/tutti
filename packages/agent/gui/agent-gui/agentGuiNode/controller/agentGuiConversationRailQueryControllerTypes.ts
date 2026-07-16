import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { WorkspaceQueryCache } from "../../../shared/query/workspaceQueryCache";
import type { AgentGuiScheduler } from "../agentGuiScheduler";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { ConversationRailDiagnosticLogger } from "./agentGuiConversationRailDiagnostics";
import type { CachedConversationRailQuery } from "./agentGuiConversationRailQueryCache";

export interface ConversationRailQueryScope {
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  previewMode: boolean;
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
  runtime: ConversationRailQueryRuntime;
  sessionSectionsQueryCache?: WorkspaceQueryCache<CachedConversationRailQuery>;
  scheduler?: AgentGuiScheduler;
  workspaceId: string;
}
