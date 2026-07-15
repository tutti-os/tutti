import { selectWorkspaceAgentConsumerSessions } from "@tutti-os/agent-activity-core";
import { useDeferredValue, useEffect, useMemo, useRef } from "react";
import { useAgentActivityRuntime } from "../../../agentActivityRuntime";
import { projectCanonicalAgentGUIConversationSummaries } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
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
  sectionAgentTargetFallbackId: string | null;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  workspaceId: string;
}

export function useAgentGUIConversationRailQuery({
  activeConversationId,
  conversationFilter,
  conversationQuery,
  previewMode,
  sectionAgentTargetFallbackId,
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
  const deferredConversationQuery = useDeferredValue(conversationQuery);
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
      sectionAgentTargetFallbackId,
      userProjects
    });
    controller.setSearchQuery(deferredConversationQuery);
  }, [
    controller,
    conversationFilter,
    deferredConversationQuery,
    previewMode,
    sectionAgentTargetFallbackId,
    userProjects
  ]);

  const querySnapshot = useEngineSelector(
    controller,
    identitySnapshot,
    Object.is
  );
  const engineConsumerSessions = useEngineSelector(
    engine,
    selectWorkspaceAgentConsumerSessions
  );
  const runtimeRailConversations = useMemo(
    () => projectCanonicalAgentGUIConversationSummaries(engineConsumerSessions),
    [engineConsumerSessions]
  );

  return useMemo(
    () => ({
      ...querySnapshot,
      loadMoreSectionConversations: (
        section: Parameters<
          AgentGUIConversationRailQueryController["loadMoreSectionConversations"]
        >[0]
      ) => controller.loadMoreSectionConversations(section),
      railSearch: {
        ...querySnapshot.railSearch,
        loadMore: () => controller.loadMoreSearchResults(),
        retry: () => controller.retrySearchResults()
      },
      runtimeRailConversations
    }),
    [controller, querySnapshot, runtimeRailConversations]
  );
}

function identitySnapshot(
  snapshot: AgentGUIConversationRailQuerySnapshot
): AgentGUIConversationRailQuerySnapshot {
  return snapshot;
}
