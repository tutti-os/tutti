import type { AgentGUIProvider } from "../../../types";

export interface AgentGUIConversationFilterTargetInput {
  provider: AgentGUIProvider;
  agentTargetId: string;
}

export type AgentGUIConversationFilterTargetSelection = (
  input: AgentGUIConversationFilterTargetInput
) => void;

export type AgentGUIProjectActionDialog =
  | {
      kind: "batch-delete";
      conversationCount: number;
      label: string;
      sessionIds: string[];
    }
  | {
      kind: "batch-delete-conversations";
      conversationCount: number;
      label: string;
      sessionIds: string[];
    }
  | {
      kind: "remove";
      label: string;
      path: string;
      sectionKey: string;
    };
