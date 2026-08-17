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
  AgentGUIConversationProjectResolver,
  AgentGUIConversationProjectSummary,
  AgentGUIConversationUserProject
} from "./agentGuiConversationProjectResolver";

export const AGENT_GUI_RUNTIME_SESSION_ORIGIN =
  WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN;
export {
  resolveAgentGUIConversationProjectBySectionKey,
  resolveAgentGUISelectedUserProject,
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
  isolation?: AgentActivitySession["isolation"];
  railSectionKey?: string;
  project?: AgentGUIConversationProjectSummary | null;
  pinnedAtUnixMs?: number | null;
  sortTimeUnixMs?: number;
  updatedAtUnixMs: number;
  hasUnreadCompletion?: boolean;
  unreadCompletionKey?: string | null;
  needsUserAction?: boolean;
  // The backing session is invisible (session.visible === false). The summary
  // still exists so an explicitly opened session presents its real identity,
  // but it must never be rendered as a conversation rail row.
  hiddenFromRail?: boolean;
  // The summary was injected only because its session was explicitly selected
  // while it was absent from the canonical conversation snapshot. The
  // presentation layer may use it for the ordinary Rail/detail overlay, but
  // it is excluded before Activity candidates are built.
  isTransient?: boolean;
  projectionSource?: "pending_activation" | "runtime_overlay";
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
  | "isolation"
  | "railSectionKey"
  | "project"
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
      agentSessionId?: string;
      turnId?: string;
      requestId: string;
      title: string;
      questions: AgentGUIInteractiveQuestion[];
    }
  | Extract<AgentConversationPromptVM, { kind: "exit-plan" }>
  | Extract<AgentConversationPromptVM, { kind: "plan-implementation" }>;

export interface BuildAgentGUIConversationsInput {
  conversationFilter?: AgentGUIConversationFilter;
  snapshot: AgentActivitySnapshot;
  provider: AgentGUIProvider;
  sessionMessagesById?: Record<string, AgentActivityMessage[]>;
  userProjects?: readonly AgentGUIConversationUserProject[];
}
