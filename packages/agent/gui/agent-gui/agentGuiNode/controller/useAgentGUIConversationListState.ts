import {
  selectAttentionReadState,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { useMemo, useRef, useState } from "react";
import {
  useAgentGuiConversationList,
  type AgentGUIConversationListQuery
} from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import type { AgentGUINodeData, AgentGUIAgentTarget } from "../../../types";
import {
  createAgentGUIConversationFilterState,
  type AgentGUIConversationFilter
} from "../model/agentGuiConversationFilter";

interface UseAgentGUIConversationListStateInput {
  agentActivityRuntimeOrigin: string;
  currentUserId?: string | null;
  data: AgentGUINodeData;
  normalizedProviderTargets: readonly AgentGUIAgentTarget[];
  sessionEngine: AgentSessionEngine;
  workspaceId: string;
}

export function useAgentGUIConversationListState({
  agentActivityRuntimeOrigin,
  currentUserId,
  data,
  normalizedProviderTargets,
  sessionEngine,
  workspaceId
}: UseAgentGUIConversationListStateInput) {
  const [conversationFilter, setConversationFilter] =
    useState<AgentGUIConversationFilter>(
      () => createAgentGUIConversationFilterState().filter
    );
  const conversationFilterRef = useRef(conversationFilter);
  conversationFilterRef.current = conversationFilter;
  const conversationListQuery =
    useMemo<AgentGUIConversationListQuery | null>(() => {
      const userId = currentUserId?.trim() ?? "";
      const provider = data.provider?.trim() ?? "";
      if (!workspaceId.trim() || !userId || !provider) {
        return null;
      }
      return {
        conversationFilter,
        workspaceId,
        userId,
        provider: data.provider,
        sessionOrigin: agentActivityRuntimeOrigin
      };
    }, [
      agentActivityRuntimeOrigin,
      conversationFilter,
      currentUserId,
      data.provider,
      workspaceId
    ]);
  const conversationListState = useAgentGuiConversationList(
    sessionEngine,
    conversationListQuery,
    normalizedProviderTargets
  );
  const canonicalConversations = conversationListState?.conversations ?? [];
  const attentionReadState = useEngineSelector(sessionEngine, (state) =>
    selectAttentionReadState(state, currentUserId)
  );
  const conversations = useMemo(() => {
    return canonicalConversations.map((conversation) => {
      const attention = attentionReadState.recordsBySessionId[conversation.id];
      return attention
        ? {
            ...conversation,
            hasUnreadCompletion: attention.isUnread,
            unreadCompletionKey: attention.completionKey
          }
        : conversation;
    });
  }, [attentionReadState.recordsBySessionId, canonicalConversations]);

  return {
    attentionReadState,
    conversationFilter,
    conversationFilterRef,
    conversationListQuery,
    conversationListState,
    conversations,
    setConversationFilter
  };
}
