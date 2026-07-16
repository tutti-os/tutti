import {
  selectWorkspaceAgentConsumerSessions,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { projectCanonicalAgentGUIConversationSummaries } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import { createAgentGUIConversationRailTitlePromptSelector } from "../../../shared/agentConversationRailTitlePromptSelector";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";

export function createConversationRailEngineProjection(): (
  state: AgentSessionEngineState
) => AgentGUIConversationSummary[] {
  const selectTitlePrompts =
    createAgentGUIConversationRailTitlePromptSelector();
  return (state) =>
    projectCanonicalAgentGUIConversationSummaries(
      selectWorkspaceAgentConsumerSessions(state),
      selectTitlePrompts(state)
    );
}
