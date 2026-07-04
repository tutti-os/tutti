import type { WorkspaceAgentActivityCard } from "../../workspaceAgentActivityListViewModel";
import type { WorkspaceAgentSessionDetailViewModel } from "../../workspaceAgentSessionDetailViewModel";
import type {
  AgentApprovalItemVM,
  AgentApprovalOptionVM
} from "./agentApprovalItemVM";
import type { AgentAskUserQuestionVM } from "./agentAskUserQuestionItemVM";
import type { AgentTranscriptRowVM } from "./agentTranscriptRowVM";

export type AgentConversationPromptVM =
  | AgentApprovalItemVM
  | {
      kind: "ask-user";
      requestId: string;
      title: string;
      questions: AgentAskUserQuestionVM[];
    }
  | {
      kind: "exit-plan";
      requestId: string;
      title: string;
      // Permission-mode options the runtime offered for leaving plan mode
      // ("Yes, and ..."), in runtime order, excluding the keep-planning
      // (`plan`) option. Empty when the runtime sent no options (Codex plan /
      // legacy `exitplanmode` tool), in which case the surface falls back to a
      // curated default mode list.
      options: AgentApprovalOptionVM[];
      // The runtime option id for "keep planning". The daemon models exit-plan
      // as an approval that requires an option id, so declining must submit this
      // id rather than a bare deny. Absent for option-less payloads, where the
      // surface falls back to a plain deny action.
      keepPlanningOptionId?: string;
    }
  | {
      // Codex plan-mode "implement this plan?" decision. Unlike exit-plan it
      // has no server request; requestId carries the plan turn id so the
      // surface and dismissal can key off it. Actions: implement/feedback/skip.
      kind: "plan-implementation";
      requestId: string;
      title: string;
    };

export type AgentConversationPendingInteractivePromptVM = Exclude<
  AgentConversationPromptVM,
  AgentApprovalItemVM
>;

export interface AgentConversationVM {
  activity: WorkspaceAgentActivityCard;
  workspaceRoot: string | null;
  sourceDetail: WorkspaceAgentSessionDetailViewModel;
  rows: AgentTranscriptRowVM[];
  pendingApproval: AgentApprovalItemVM | null;
  pendingInteractivePrompt: AgentConversationPendingInteractivePromptVM | null;
}
