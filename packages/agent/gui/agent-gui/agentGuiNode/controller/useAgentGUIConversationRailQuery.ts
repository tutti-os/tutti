import {
  selectWorkspaceAgentConsumerSessions,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { useEffect, useMemo, useRef } from "react";
import { useAgentActivityRuntime } from "../../../agentActivityRuntime";
import { projectCanonicalAgentGUIConversationSummaries } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import { createAgentGUIConversationRailTitlePromptSelector } from "../../../shared/agentConversationRailTitlePromptSelector";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { conversationSummariesRenderEqual } from "../model/agentGuiConversationRail";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import {
  AgentGUIConversationRailQueryController,
  type AgentGUIConversationRailQuerySnapshot
} from "./AgentGUIConversationRailQueryController";

export interface AgentGUIConversationRailInput {
  activeConversationId: string | null;
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  conversationQuery: string;
  previewMode: boolean;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  workspaceId: string;
}

export function useAgentGUIConversationRailQuery({
  activeConversationId,
  conversationFilter,
  conversationQuery,
  previewMode,
  userProjects,
  workspaceId
}: AgentGUIConversationRailInput) {
  const runtime = useAgentActivityRuntime();
  const engine = useMemo(
    () => runtime.getSessionEngine(workspaceId),
    [runtime, workspaceId]
  );
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const controller = useMemo(
    () =>
      new AgentGUIConversationRailQueryController({
        engine,
        getActiveConversationId: () => activeConversationIdRef.current,
        runtime,
        workspaceId
      }),
    [engine, runtime, workspaceId]
  );

  useEffect(() => controller.attach(), [controller]);
  useEffect(() => {
    controller.configure({
      conversationFilter,
      previewMode,
      userProjects
    });
    controller.setSearchQuery(conversationQuery);
  }, [
    controller,
    conversationFilter,
    conversationQuery,
    previewMode,
    userProjects
  ]);

  const querySnapshot = useEngineSelector(
    controller,
    identitySnapshot,
    Object.is
  );
  const selectRuntimeRailConversations = useMemo(
    () =>
      createRuntimeRailConversationsSelector(
        createAgentGUIConversationRailTitlePromptSelector()
      ),
    []
  );
  const runtimeRailConversations = useEngineSelector(
    engine,
    selectRuntimeRailConversations,
    conversationSummaryListsRenderEqual
  );
  return useMemo(
    () => ({
      ...querySnapshot,
      isInteractionLocked: controller.isInteractionLocked,
      loadMoreSectionConversations: controller.loadMoreSectionConversations,
      railSearch: {
        ...querySnapshot.railSearch,
        loadMore: controller.loadMoreSearchResults,
        retry: controller.retrySearchResults
      },
      runtimeRailConversations
    }),
    [controller, querySnapshot, runtimeRailConversations]
  );
}

function createRuntimeRailConversationsSelector(
  selectTitlePrompts: ReturnType<
    typeof createAgentGUIConversationRailTitlePromptSelector
  >
): (state: AgentSessionEngineState) => AgentGUIConversationSummary[] {
  return (state) =>
    projectCanonicalAgentGUIConversationSummaries(
      selectWorkspaceAgentConsumerSessions(state),
      selectTitlePrompts(state)
    );
}

function conversationSummaryListsRenderEqual(
  left: readonly AgentGUIConversationSummary[],
  right: readonly AgentGUIConversationSummary[]
): boolean {
  return (
    left.length === right.length &&
    left.every((conversation, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        conversationSummariesRenderEqual(conversation, other)
      );
    })
  );
}

function identitySnapshot(
  snapshot: AgentGUIConversationRailQuerySnapshot
): AgentGUIConversationRailQuerySnapshot {
  return snapshot;
}
