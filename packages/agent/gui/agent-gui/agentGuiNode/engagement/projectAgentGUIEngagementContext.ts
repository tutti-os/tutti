import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIEngagementContext } from "./agentGUIEngagement.types";

export function projectAgentGUIEngagementContext(
  viewModel: AgentGUINodeViewModel,
  composerReady: boolean
): { context: AgentGUIEngagementContext; contextKey: string } {
  const agentSessionId = viewModel.rail.activeConversationId;
  const provider =
    viewModel.rail.activeConversation?.provider ??
    viewModel.rail.selectedAgentTarget.provider ??
    viewModel.shell.data.provider;
  const agentTargetId =
    viewModel.rail.activeConversation?.agentTargetId ??
    viewModel.rail.selectedAgentTarget.agentTargetId ??
    viewModel.rail.selectedAgentTarget.targetId ??
    null;
  return {
    context: {
      agentSessionId,
      agentTargetId,
      composerReady,
      conversationState: agentSessionId ? "existing" : "new",
      provider
    },
    contextKey: createAgentGUIEngagementContextKey({
      agentSessionId,
      agentTargetId,
      provider
    })
  };
}

export function createAgentGUIEngagementContextKey(input: {
  agentSessionId: string | null;
  agentTargetId: string | null;
  provider: string;
}): string {
  return JSON.stringify([
    input.agentSessionId ? "session" : "home",
    input.agentSessionId,
    input.provider,
    input.agentTargetId
  ]);
}
