import type { AgentApprovalPurpose } from "../agentApprovalPurpose";

export interface AgentApprovalOptionVM {
  id: string;
  label: string;
  kind: string;
  description?: string;
}

export interface AgentApprovalItemVM {
  kind: "approval";
  id: string;
  turnId: string;
  requestId: string;
  callId: string;
  approvalPurpose?: AgentApprovalPurpose;
  title: string;
  toolName: string | null;
  status: string | null;
  input: Record<string, unknown> | null;
  options: AgentApprovalOptionVM[];
  output?: Record<string, unknown> | null;
  occurredAtUnixMs: number | null;
}
