export interface WorkspaceAgentDecisionIdentity {
  agentIconUrl: string;
  agentName: string;
}

export function resolveWorkspaceAgentDecisionIdentity(input: {
  agentAvatarUrl?: string | null;
  agentName?: string | null;
  fallbackAgentIconUrl: string;
  fallbackAgentName: string;
}): WorkspaceAgentDecisionIdentity {
  return {
    agentIconUrl:
      input.agentAvatarUrl?.trim() || input.fallbackAgentIconUrl.trim(),
    agentName: input.agentName?.trim() || input.fallbackAgentName.trim()
  };
}
