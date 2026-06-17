import { useCallback, useState } from "react";
import type { AgentGUIConversationListQuery } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore";
import { getAgentGUIConversationCreatePending } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore";

export function useAgentConversationSelectionState(input: {
  conversationListQuery: AgentGUIConversationListQuery | null;
  nodeId: string | undefined;
  initialActiveConversationId: string | null;
  initialComposerHome: boolean;
}) {
  const pendingCreateOwnerKey = input.nodeId?.trim() ?? "";
  const resolvePendingCreateConversationId = useCallback(
    () =>
      input.conversationListQuery && pendingCreateOwnerKey
        ? getAgentGUIConversationCreatePending({
            query: input.conversationListQuery,
            ownerKey: pendingCreateOwnerKey
          })
        : null,
    [input.conversationListQuery, pendingCreateOwnerKey]
  );
  const [pendingCreateConversationId, setPendingCreateConversationId] =
    useState(resolvePendingCreateConversationId);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(input.initialActiveConversationId);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(
    null
  );
  const [isComposerHome, setIsComposerHome] = useState(
    input.initialComposerHome
  );
  const [localIsCreatingConversation, setLocalIsCreatingConversation] =
    useState(false);
  const isCreatingConversation =
    localIsCreatingConversation || pendingCreateConversationId !== null;

  return {
    activeConversationId,
    isComposerHome,
    isCreatingConversation,
    localIsCreatingConversation,
    pendingCreateConversationId,
    pendingCreateOwnerKey,
    resolvePendingCreateConversationId,
    selectedProjectPath,
    setActiveConversationId,
    setIsComposerHome,
    setLocalIsCreatingConversation,
    setPendingCreateConversationId,
    setSelectedProjectPath
  };
}
