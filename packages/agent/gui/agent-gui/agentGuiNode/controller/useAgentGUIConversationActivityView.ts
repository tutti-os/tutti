import { useCallback, useMemo } from "react";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import type { AgentGUIConversationActivityController } from "./agentGUIConversationActivityController";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationTypes";
import { projectAgentGUIConversationActivity } from "../model/agentGuiConversationActivityView";

export interface AgentGUIConversationActivityViewController {
  available: boolean;
  conversationsById: ReadonlyMap<string, AgentGUIConversationSummary>;
  enabled: boolean;
  needsAttention: boolean;
  presentationActive: boolean;
  projection: ReturnType<typeof projectAgentGUIConversationActivity> | null;
  toggle: () => void;
}

const EMPTY_ACTIVITY_CONVERSATIONS_BY_ID: ReadonlyMap<
  string,
  AgentGUIConversationSummary
> = new Map();
const EMPTY_DELETED_SESSION_IDS: Readonly<Record<string, true>> = {};

export function useAgentGUIConversationActivityView({
  activityController,
  conversations,
  hasConversationQuery,
  deletedSessionIds = EMPTY_DELETED_SESSION_IDS
}: {
  activityController: AgentGUIConversationActivityController;
  conversations: readonly AgentGUIConversationSummary[];
  hasConversationQuery: boolean;
  deletedSessionIds?: Readonly<Record<string, true>>;
}): AgentGUIConversationActivityViewController {
  const state = useEngineSelector(
    activityController,
    (snapshot) => snapshot,
    Object.is
  );

  const available = state.available;
  const enabled = state.enabled;
  const currentConversationsById = useMemo(
    () =>
      available
        ? new Map(
            conversations.flatMap((conversation) =>
              deletedSessionIds[conversation.id]
                ? []
                : [[conversation.id, conversation]]
            )
          )
        : EMPTY_ACTIVITY_CONVERSATIONS_BY_ID,
    [available, conversations, deletedSessionIds]
  );
  const conversationsById = useMemo(() => {
    if (!available) return EMPTY_ACTIVITY_CONVERSATIONS_BY_ID;
    if (!enabled || !state.activation) return currentConversationsById;
    const result = new Map(currentConversationsById);
    for (const member of [
      ...state.activation.priority,
      ...state.activation.recent
    ]) {
      if (result.has(member.id)) continue;
      const cached = state.conversationCache.get(member.id);
      if (cached) result.set(member.id, cached);
    }
    return result;
  }, [
    available,
    currentConversationsById,
    enabled,
    state.activation,
    state.conversationCache
  ]);
  const needsAttention = useMemo(
    () =>
      available &&
      conversations.some(
        (conversation) =>
          !deletedSessionIds[conversation.id] &&
          (conversation.needsUserAction || conversation.hasUnreadCompletion)
      ),
    [available, conversations, deletedSessionIds]
  );
  const projection = useMemo(
    () =>
      enabled && state.activation
        ? projectAgentGUIConversationActivity(state.activation)
        : null,
    [enabled, state.activation]
  );
  const toggle = useCallback(() => {
    activityController.toggle();
  }, [activityController]);
  return useMemo(
    () => ({
      available,
      conversationsById,
      enabled,
      needsAttention,
      presentationActive: enabled && !hasConversationQuery,
      projection,
      toggle
    }),
    [
      available,
      conversationsById,
      enabled,
      hasConversationQuery,
      needsAttention,
      projection,
      toggle
    ]
  );
}
