import type { ToolCallStatusKind } from "../../workspaceAgentToolCallDisplay";
import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentTimelineTypes";
import type { AgentApprovalItemVM } from "./agentApprovalItemVM";
import type { AgentAskUserQuestionItemVM } from "./agentAskUserQuestionItemVM";
import type { AgentPlanModeItemVM } from "./agentPlanModeItemVM";
import type { AgentTaskItemVM } from "./agentTaskItemVM";

export type AgentToolRendererKind =
  | "default"
  | "approval"
  | "plan-enter"
  | "plan-exit"
  | "ask-user"
  | "task"
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "search"
  | "web-search"
  | "web-fetch"
  | "image-generation"
  | "todo-write"
  | "tool-search"
  | "skill"
  | "mcp";

export interface AgentToolCallVM {
  kind: "tool-call";
  id: string;
  turnId: string;
  name: string;
  toolName: string | null;
  callType: string | null;
  status: string | null;
  statusKind: ToolCallStatusKind | null;
  summary: string;
  compactSummary: string | null;
  payload: Record<string, unknown> | null;
  toolState: Record<string, unknown> | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  content: unknown[] | null;
  locations: unknown[] | null;
  rendererKind: AgentToolRendererKind;
  approval: AgentApprovalItemVM | null;
  planMode: AgentPlanModeItemVM | null;
  askUserQuestion: AgentAskUserQuestionItemVM | null;
  task: AgentTaskItemVM | null;
  occurredAtUnixMs: number | null;
  sourceTimelineItems?: WorkspaceAgentActivityTimelineItem[];
}
