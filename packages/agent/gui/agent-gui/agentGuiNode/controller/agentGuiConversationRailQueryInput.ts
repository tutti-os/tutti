import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";

export function agentTargetQueryInput(agentTargetId: string): {
  agentTargetId?: string;
} {
  return agentTargetId ? { agentTargetId } : {};
}

export function conversationRailScopeKey(input: {
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  previewMode: boolean;
  workspaceId: string;
}): string {
  const agentTargetId =
    input.conversationFilter.kind === "agentTarget"
      ? input.conversationFilter.agentTargetId.trim()
      : "";
  return JSON.stringify([
    input.workspaceId,
    agentTargetId ? `agentTarget:${agentTargetId}` : "all",
    input.previewMode,
    agentTargetId
  ]);
}
