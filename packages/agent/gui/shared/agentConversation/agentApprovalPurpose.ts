export type AgentApprovalPurpose = "edit-files";

export function normalizeAgentApprovalPurpose(
  value: unknown
): AgentApprovalPurpose | null {
  return value === "edit-files" ? value : null;
}
