import { useCallback, useMemo, useState } from "react";
import {
  useAgentGUIRuntime,
  type AgentGUIRuntime
} from "../../../agentActivityRuntime";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationTypes";
import {
  createAgentGUIConversationActivityActivation,
  projectAgentGUIConversationActivity,
  reconcileAgentGUIConversationActivityActivation,
  type AgentGUIConversationActivityActivation
} from "../model/agentGuiConversationActivityView";
import type { AgentGUIConversationActivityRootFact } from "./useAgentGUIConversationRailQuery";

interface AgentGUIConversationActivityViewState {
  activation: AgentGUIConversationActivityActivation | null;
  enabled: boolean;
  identityKey: string | null;
  runtime: AgentGUIRuntime | null;
  scopeKey: string | null;
}

const DISABLED_ACTIVITY_VIEW_STATE: AgentGUIConversationActivityViewState = {
  activation: null,
  enabled: false,
  identityKey: null,
  runtime: null,
  scopeKey: null
};

export interface AgentGUIConversationActivityViewController {
  available: boolean;
  conversationsById: ReadonlyMap<string, AgentGUIConversationSummary>;
  enabled: boolean;
  needsAttention: boolean;
  presentationActive: boolean;
  projection: ReturnType<typeof projectAgentGUIConversationActivity> | null;
  toggle: () => void;
}

const EMPTY_ACTIVITY_CONVERSATIONS: readonly AgentGUIConversationSummary[] = [];
const EMPTY_ACTIVITY_CONVERSATIONS_BY_ID: ReadonlyMap<
  string,
  AgentGUIConversationSummary
> = new Map();

export function useAgentGUIConversationActivityView({
  conversations,
  hasConversationQuery,
  identityKey = "",
  rootFacts,
  scopeKey
}: {
  conversations: readonly AgentGUIConversationSummary[];
  hasConversationQuery: boolean;
  identityKey?: string;
  rootFacts: ReadonlyMap<string, AgentGUIConversationActivityRootFact>;
  scopeKey: string;
}): AgentGUIConversationActivityViewController {
  const runtime = useAgentGUIRuntime();
  const available = runtime.conversationActivityViewEnabled === true;
  const activityConversations = useMemo(
    () =>
      available
        ? conversations.map((conversation) => {
            const fact = rootFacts.get(conversation.id);
            if (
              !fact ||
              (fact.needsUserAction === Boolean(conversation.needsUserAction) &&
                fact.status === conversation.status)
            ) {
              return conversation;
            }
            return {
              ...conversation,
              needsUserAction: fact.needsUserAction,
              status: fact.status
            };
          })
        : EMPTY_ACTIVITY_CONVERSATIONS,
    [available, conversations, rootFacts]
  );
  const [storedState, setStoredState] =
    useState<AgentGUIConversationActivityViewState>(
      DISABLED_ACTIVITY_VIEW_STATE
    );

  let state = storedState;
  if (!available && state !== DISABLED_ACTIVITY_VIEW_STATE) {
    state = DISABLED_ACTIVITY_VIEW_STATE;
    setStoredState(state);
  } else if (available && state.enabled) {
    const sameIdentity =
      state.identityKey === identityKey && state.runtime === runtime;
    const activation =
      sameIdentity && state.scopeKey === scopeKey && state.activation
        ? reconcileAgentGUIConversationActivityActivation(
            state.activation,
            activityConversations
          )
        : createAgentGUIConversationActivityActivation(
            activityConversations,
            Date.now(),
            sameIdentity
              ? state.activation?.priorityRetentionRecencyById
              : undefined
          );
    if (
      activation !== state.activation ||
      state.identityKey !== identityKey ||
      state.runtime !== runtime ||
      state.scopeKey !== scopeKey
    ) {
      state = {
        activation,
        enabled: true,
        identityKey,
        runtime,
        scopeKey
      };
      setStoredState(state);
    }
  }

  const enabled = available && state.enabled;
  const conversationsById = useMemo(
    () =>
      available
        ? new Map(
            activityConversations.map((conversation) => [
              conversation.id,
              conversation
            ])
          )
        : EMPTY_ACTIVITY_CONVERSATIONS_BY_ID,
    [activityConversations, available]
  );
  const needsAttention = useMemo(
    () =>
      available &&
      activityConversations.some(
        (conversation) =>
          conversation.needsUserAction || conversation.hasUnreadCompletion
      ),
    [activityConversations, available]
  );
  const projection = useMemo(
    () =>
      state.activation
        ? projectAgentGUIConversationActivity(state.activation)
        : null,
    [state.activation]
  );
  const toggle = useCallback(() => {
    if (enabled) {
      setStoredState(DISABLED_ACTIVITY_VIEW_STATE);
      return;
    }
    setStoredState({
      activation: createAgentGUIConversationActivityActivation(
        activityConversations,
        Date.now()
      ),
      enabled: true,
      identityKey,
      runtime,
      scopeKey
    });
  }, [activityConversations, enabled, identityKey, runtime, scopeKey]);
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
