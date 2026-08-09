import type { AgentGUIInteractionReadinessIdentity } from "../../../types";

export function resolveAgentGUIInteractionReadinessIdentity(input: {
  agentSessionId: string | null | undefined;
  requestId: string | null | undefined;
  turnId: string | null | undefined;
  workspaceId: string;
}): AgentGUIInteractionReadinessIdentity | null {
  const agentSessionId = input.agentSessionId?.trim() ?? "";
  const workspaceId = input.workspaceId.trim();
  const requestId = input.requestId?.trim() ?? "";
  const turnId = input.turnId?.trim() ?? "";
  return agentSessionId && workspaceId && requestId && turnId
    ? { agentSessionId, workspaceId, requestId, turnId }
    : null;
}
