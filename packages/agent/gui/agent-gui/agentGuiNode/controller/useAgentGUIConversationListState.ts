import {
  selectAttentionReadState,
  selectPendingActivations,
  type AgentActivitySnapshot,
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
import { resolveAgentGUIConversationTitleFromTimelineItems } from "../model/agentGuiConversationModel";
import { projectAgentGUIMessagesToTimelineItems } from "./agentGuiController.promptHelpers";

interface UseAgentGUIConversationListStateInput {
  agentActivityRuntimeOrigin: string;
  agentActivitySnapshot: AgentActivitySnapshot;
  currentUserId?: string | null;
  data: AgentGUINodeData;
  normalizedProviderTargets: readonly AgentGUIAgentTarget[];
  sessionEngine: AgentSessionEngine;
  workspaceId: string;
}

export function useAgentGUIConversationListState({
  agentActivityRuntimeOrigin,
  agentActivitySnapshot,
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
    conversationListQuery
  );
  const canonicalConversations = conversationListState?.conversations ?? [];
  const attentionReadState = useEngineSelector(sessionEngine, (state) =>
    selectAttentionReadState(state, currentUserId)
  );
  const pendingNewActivationProjection = useEngineSelector(
    sessionEngine,
    (state) =>
      selectPendingActivations(state)
        .filter(
          (activation) =>
            activation.mode === "new" &&
            (activation.status === "requested" ||
              activation.status === "uncertain")
        )
        .at(-1) ?? null
  );
  const conversations = useMemo(() => {
    const projected = canonicalConversations.map((conversation) => {
      const projectedTitle = resolveAgentGUIConversationTitleFromTimelineItems({
        conversation,
        timelineItems: projectAgentGUIMessagesToTimelineItems(
          agentActivitySnapshot.sessionMessagesById[conversation.id] ?? []
        )
      });
      const attention = attentionReadState.recordsBySessionId[conversation.id];
      return projectedTitle || attention
        ? {
            ...conversation,
            ...(projectedTitle ?? {}),
            ...(attention
              ? {
                  hasUnreadCompletion: attention.isUnread,
                  unreadCompletionKey: attention.completionKey
                }
              : {})
          }
        : conversation;
    });
    const pending = pendingNewActivationProjection;
    if (
      !pending ||
      projected.some((item) => item.id === pending.agentSessionId)
    ) {
      return projected;
    }
    const target = normalizedProviderTargets.find(
      (candidate) => candidate.agentTargetId === pending.agentTargetId
    );
    return [
      ...projected,
      {
        id: pending.agentSessionId,
        userId: currentUserId?.trim() ?? "",
        provider: target?.provider ?? data.provider,
        agentTargetId: pending.agentTargetId,
        title: pending.title ?? "",
        titleFallback: null,
        status: "working" as const,
        cwd: pending.cwd,
        project: null,
        sortTimeUnixMs: pending.requestedAtUnixMs,
        updatedAtUnixMs: pending.requestedAtUnixMs
      }
    ];
  }, [
    agentActivitySnapshot.sessionMessagesById,
    attentionReadState.recordsBySessionId,
    canonicalConversations,
    currentUserId,
    data.provider,
    normalizedProviderTargets,
    pendingNewActivationProjection
  ]);

  return {
    attentionReadState,
    conversationFilter,
    conversationFilterRef,
    conversationListQuery,
    conversationListState,
    conversations,
    pendingNewActivationProjection,
    setConversationFilter
  };
}
