import { useCallback, useRef } from "react";
import type { AgentGUINodeData } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";

export type ConversationIntent =
  | { tag: "home" }
  | { tag: "requested"; id: string }
  | { tag: "resolving"; id: string }
  | { tag: "active"; id: string };

export function resolveConversationSummaryById(
  conversations: readonly AgentGUIConversationSummary[],
  conversationId: string | null | undefined,
  transientConversation: AgentGUIConversationSummary | null = null
): AgentGUIConversationSummary | null {
  const normalized = conversationId?.trim() ?? "";
  if (!normalized) return null;
  return (
    conversations.find((conversation) => conversation.id === normalized) ??
    (transientConversation?.id === normalized ? transientConversation : null)
  );
}

interface AgentConversationSelectionInput {
  activation: {
    forget(agentSessionId: string): void;
    getPendingSessionId(): string | null;
  };
  conversations: { contains(agentSessionId: string): boolean };
  detail: {
    hasRenderableMessages(agentSessionId: string): boolean;
    markPending(agentSessionId: string): void;
    reload(
      agentSessionId: string,
      options: { reloadConversations: boolean; reloadDetail: boolean }
    ): void;
    setLoading(loading: boolean): void;
  };
  hasConversationListQuery(): boolean;
  isMounted(): boolean;
  onMissingConversationListQuery(previousAgentSessionId: string | null): void;
  persistence: {
    update(updater: (current: AgentGUINodeData) => AgentGUINodeData): void;
  };
  selection: {
    clearDetailError(): void;
    getActiveSessionId(): string | null;
    setActiveSessionId(agentSessionId: string | null): void;
    setComposerHome(home: boolean): void;
    setIntent(intent: ConversationIntent): void;
  };
}

export function useAgentConversationSelection(
  input: AgentConversationSelectionInput
) {
  const inputRef = useRef(input);
  inputRef.current = input;

  const persistActiveConversation = useCallback(
    (agentSessionId: string | null) => {
      inputRef.current.persistence.update((current) => {
        if (current.lastActiveAgentSessionId === agentSessionId) return current;
        return {
          ...current,
          lastActiveAgentSessionId: agentSessionId
        };
      });
    },
    []
  );

  const selectConversation = useCallback(
    (agentSessionId: string, options?: { reloadConversations?: boolean }) => {
      const normalized = agentSessionId.trim();
      if (!normalized) return;
      const current = inputRef.current;
      const previous = current.selection.getActiveSessionId();
      const hasRenderableMessages =
        current.detail.hasRenderableMessages(normalized);
      current.selection.setComposerHome(false);
      const pendingSessionId = current.activation.getPendingSessionId();
      if (previous && previous !== normalized)
        current.activation.forget(previous);
      if (previous !== normalized) {
        if (hasRenderableMessages) {
          current.detail.setLoading(false);
        } else {
          current.detail.markPending(normalized);
        }
      }
      if (pendingSessionId && pendingSessionId !== normalized) {
        current.activation.forget(pendingSessionId);
      }
      const reloadConversations =
        options?.reloadConversations !== false &&
        current.conversations.contains(normalized);
      current.selection.setIntent({ tag: "active", id: normalized });
      current.selection.setActiveSessionId(normalized);
      current.selection.clearDetailError();
      current.detail.reload(normalized, {
        reloadConversations,
        reloadDetail: previous === normalized || !hasRenderableMessages
      });
      persistActiveConversation(normalized);
    },
    [persistActiveConversation]
  );

  const syncConversationListProjection = useCallback(
    async (_preferredSessionId?: string | null) => {
      const current = inputRef.current;
      if (current.hasConversationListQuery()) return;
      const previous = current.selection.getActiveSessionId();
      current.onMissingConversationListQuery(previous);
      current.selection.setIntent({ tag: "home" });
      current.selection.setComposerHome(true);
      current.selection.setActiveSessionId(null);
      current.detail.setLoading(false);
      current.selection.clearDetailError();
      persistActiveConversation(null);
    },
    [persistActiveConversation]
  );

  const isCurrentConversation = useCallback(
    (agentSessionId: string) =>
      inputRef.current.isMounted() &&
      inputRef.current.selection.getActiveSessionId() === agentSessionId.trim(),
    []
  );
  const isConversationStale = useCallback(
    (agentSessionId: string) => {
      const normalized = agentSessionId.trim();
      return Boolean(normalized && !isCurrentConversation(normalized));
    },
    [isCurrentConversation]
  );

  return {
    isCurrentConversation,
    isConversationStale,
    persistActiveConversation,
    selectConversation,
    syncConversationListProjection
  };
}
