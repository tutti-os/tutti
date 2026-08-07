import type { AgentGUIProvider } from "../../../types";

export interface AgentGUIConversationFilterTargetInput {
  provider: AgentGUIProvider;
  agentTargetId: string;
}

export type AgentGUIConversationFilterTargetSelection = (
  input: AgentGUIConversationFilterTargetInput
) => void;
