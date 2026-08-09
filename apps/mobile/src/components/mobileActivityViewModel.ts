import {
  createAgentGUIConversationActivityActivation,
  projectAgentGUIConversationActivity,
  reconcileAgentGUIConversationActivityActivation,
  type AgentGUIConversationActivityActivation,
  type AgentGUIConversationActivityProjection
} from "@tutti-os/agent-gui/conversation-activity-projection";
import { useRef } from "react";
import type { WorkspaceActivityConversation } from "../services/workspaceActivityTypes";

export interface MobileActivityViewModel {
  conversationsById: ReadonlyMap<string, WorkspaceActivityConversation>;
  projection: AgentGUIConversationActivityProjection | null;
}

export function useMobileActivityViewModel({
  conversations,
  ready,
  scopeKey
}: {
  conversations: readonly WorkspaceActivityConversation[];
  ready: boolean;
  scopeKey: string;
}): MobileActivityViewModel {
  const stateRef = useRef<{
    activation: AgentGUIConversationActivityActivation;
    scopeKey: string;
  } | null>(null);

  if (!ready) {
    stateRef.current = null;
  } else if (!stateRef.current || stateRef.current.scopeKey !== scopeKey) {
    stateRef.current = {
      activation: createAgentGUIConversationActivityActivation(
        conversations,
        Date.now()
      ),
      scopeKey
    };
  } else {
    const activation = reconcileAgentGUIConversationActivityActivation(
      stateRef.current.activation,
      conversations
    );
    if (activation !== stateRef.current.activation) {
      stateRef.current = { ...stateRef.current, activation };
    }
  }

  return {
    conversationsById: new Map(
      conversations.map((conversation) => [conversation.id, conversation])
    ),
    projection: stateRef.current
      ? projectAgentGUIConversationActivity(stateRef.current.activation)
      : null
  };
}

export function searchConversationIds(
  model: MobileActivityViewModel,
  sessionIds: readonly string[]
): readonly WorkspaceActivityConversation[] {
  return sessionIds.flatMap((id) => {
    const conversation = model.conversationsById.get(id);
    return conversation ? [conversation] : [];
  });
}
