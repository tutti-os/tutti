export function agentTargetQueryInput(agentTargetId: string): {
  agentTargetId?: string;
} {
  return agentTargetId ? { agentTargetId } : {};
}
