import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import type { AgentGUIProvider } from "../../../types";
import type { AgentApprovalItemVM } from "../../../shared/agentConversation/contracts/agentApprovalItemVM";
import type { AgentConversationPromptVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentAskUserQuestionVM } from "../../../shared/agentConversation/contracts/agentAskUserQuestionItemVM";
import type {
  AgentGUIConversationTitleFallback,
  AgentGUIConversationTitleLeadingMentionKind,
  AgentGUIResolvedProvider
} from "../../../shared/agentConversationTitleProjection.ts";
import type {
  AgentActivitySession,
  AgentActivitySnapshot,
  AgentActivityTurn
} from "@tutti-os/agent-activity-core";
import { WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN } from "../../../shared/workspaceAgentSessionOrigin";
import type { AgentGUIConversationFilter } from "./agentGuiConversationFilter";
import type {
  AgentGUIConversationNoProjectPathResolver,
  AgentGUIConversationProjectResolver,
  AgentGUIConversationProjectSummary,
  AgentGUIConversationUserProject
} from "./agentGuiConversationProjectResolver";

export const AGENT_GUI_RUNTIME_SESSION_ORIGIN =
  WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN;
export {
  resolveAgentGUIConversationProject,
  type AgentGUIConversationNoProjectPathResolver,
  type AgentGUIConversationProjectResolutionOptions,
  type AgentGUIConversationProjectSummary,
  type AgentGUIConversationUserProject
} from "./agentGuiConversationProjectResolver";

export interface AgentGUIConversationSummary {
  id: string;
  userId?: string;
  agentTargetId?: string | null;
  provider: AgentGUIResolvedProvider;
  resumable?: boolean;
  title: string;
  titleLeadingMentionKind?: AgentGUIConversationTitleLeadingMentionKind | null;
  titleFallback?: AgentGUIConversationTitleFallback;
  status: AgentGUIConversationStatus;
  cwd: string;
  railSectionKey?: string;
  project?: AgentGUIConversationProjectSummary | null;
  projectMode?: "none";
  pinnedAtUnixMs?: number | null;
  sortTimeUnixMs?: number;
  updatedAtUnixMs: number;
  hasUnreadCompletion?: boolean;
  unreadCompletionKey?: string | null;
  needsUserAction?: boolean;
  projectionSource?: "pending_activation";
  isImported?: boolean;
  activeTurn?: AgentActivitySession["activeTurn"];
}

export type AgentGUIConversationProjectionSource = Pick<
  AgentGUIConversationSummary,
  | "id"
  | "userId"
  | "agentTargetId"
  | "provider"
  | "title"
  | "titleLeadingMentionKind"
  | "titleFallback"
  | "status"
  | "cwd"
  | "railSectionKey"
  | "project"
  | "projectMode"
  | "pinnedAtUnixMs"
  | "sortTimeUnixMs"
  | "updatedAtUnixMs"
  | "activeTurn"
> & {
  sessionTurns?: readonly AgentActivityTurn[];
};

export interface AgentGUIConversationProjectResolutionContext {
  projectResolver: AgentGUIConversationProjectResolver;
}

export type AgentGUIConversationStatus =
  | "working"
  | "waiting"
  | "ready"
  | "completed"
  | "failed"
  | "canceled";

export function resolveAgentGUIConversationSortTimeUnixMs(
  conversation: Pick<
    AgentGUIConversationSummary,
    "sortTimeUnixMs" | "updatedAtUnixMs"
  >
): number {
  return conversation.sortTimeUnixMs ?? conversation.updatedAtUnixMs;
}

export interface AgentGUITimelineRow {
  id: string;
  turnId: string;
  role: string;
  content: string;
  eventType: string;
  status: string | null;
  callType?: string;
  occurredAtUnixMs: number;
}

export type AgentGUIApprovalRequest = AgentApprovalItemVM;

export interface AgentGUIApprovalOption {
  id: string;
  label: string;
  kind: string;
  description?: string;
}

export interface AgentGUIInteractiveQuestionOption {
  label: string;
  description: string;
}

export interface AgentGUIInteractiveQuestion extends AgentAskUserQuestionVM {
  isOther?: boolean;
}

export type AgentGUIInteractivePrompt =
  | AgentGUIApprovalRequest
  | {
      kind: "ask-user";
      requestId: string;
      title: string;
      questions: AgentGUIInteractiveQuestion[];
    }
  | Extract<AgentConversationPromptVM, { kind: "exit-plan" }>
  | Extract<AgentConversationPromptVM, { kind: "plan-implementation" }>;

export interface BuildAgentGUIConversationsInput {
  conversationFilter?: AgentGUIConversationFilter;
  isNoProjectPath?: AgentGUIConversationNoProjectPathResolver;
  snapshot: AgentActivitySnapshot;
  provider: AgentGUIProvider;
  sessionMessagesById?: Record<string, AgentActivityMessage[]>;
  userProjects?: readonly AgentGUIConversationUserProject[];
}
