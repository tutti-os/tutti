import type { AgentApprovalOptionVM } from "./agentApprovalItemVM";

export type AgentPlanModeKind = "enter" | "exit";

export interface AgentPlanModeItemVM {
  itemKind: "plan-mode";
  id: string;
  turnId: string;
  requestId?: string;
  kind: AgentPlanModeKind;
  title: string;
  plan?: string | null;
  status: string | null;
  filePath?: string | null;
  // Exit-plan permission-mode options the runtime offered ("Yes, and ..."),
  // excluding the keep-planning option. Carried through to the pending
  // exit-plan prompt so the surface renders the runtime's modes rather than a
  // hardcoded list. Absent/empty for enter-plan or option-less payloads.
  options?: AgentApprovalOptionVM[];
  // The runtime option id for "keep planning" (see AgentConversationPromptVM).
  keepPlanningOptionId?: string;
  occurredAtUnixMs: number | null;
}
