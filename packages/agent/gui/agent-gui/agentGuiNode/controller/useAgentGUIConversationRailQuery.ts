import {
  selectWorkspaceAgentConsumerSessions,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { useDeferredValue, useEffect, useMemo, useRef } from "react";
import { useAgentActivityRuntime } from "../../../agentActivityRuntime";
import { projectCanonicalAgentGUIConversationSummaries } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
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
  const runtimeRailConversations = useEngineSelector(
    engine,
    selectRuntimeRailConversations,
    conversationSummaryListsRenderEqual
  );
  return useMemo(
    () => ({
      ...querySnapshot,
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

function selectRuntimeRailConversations(
  state: AgentSessionEngineState
): AgentGUIConversationSummary[] {
  return projectCanonicalAgentGUIConversationSummaries(
    selectWorkspaceAgentConsumerSessions(state)
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
