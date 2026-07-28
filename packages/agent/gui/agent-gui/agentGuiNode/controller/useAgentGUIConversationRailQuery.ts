import { useEffect, useMemo, useRef } from "react";
import { useAgentActivityRuntime } from "../../../agentActivityRuntime";
import { inspectAgentConversationBatchDeletionCapability } from "../../../agentConversationRailRuntime";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import {
  AgentGUIConversationRailQueryController,
  type AgentGUIConversationRailQuerySnapshot
} from "./AgentGUIConversationRailQueryController";
import { resolveConversationRailQueryScope } from "./agentGuiConversationRailQueryTypes";
import { reportAgentGUIConversationBatchDeletionCapabilityIncomplete } from "./agentGuiController.reporting";

export interface AgentGUIConversationRailInput {
  activeConversationId: string | null;
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  conversationQuery: string;
  nodeId?: string | null;
  registerInteractionLockProbe?: (probe: (() => boolean) | null) => void;
  sectionAgentTargetFallbackId: string | null;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  workspaceId: string;
}

export function useAgentGUIConversationRailQuery({
  activeConversationId,
  conversationFilter,
  conversationQuery,
  nodeId,
  registerInteractionLockProbe,
  sectionAgentTargetFallbackId,
  userProjects,
  workspaceId
}: AgentGUIConversationRailInput) {
  const runtime = useAgentActivityRuntime();
  const batchDeletionCapability = useMemo(
    () => inspectAgentConversationBatchDeletionCapability(runtime),
    [runtime]
  );
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
        nodeId,
        runtime,
        workspaceId
      }),
    [engine, nodeId, runtime, workspaceId]
  );

  useEffect(() => {
    if (batchDeletionCapability.partial) {
      reportAgentGUIConversationBatchDeletionCapabilityIncomplete({
        missingMethods: batchDeletionCapability.missingMethods,
        runtime,
        workspaceId
      });
    }
    const detach = controller.attach();
    registerInteractionLockProbe?.(controller.isInteractionLocked);
    return () => {
      registerInteractionLockProbe?.(null);
      detach();
    };
  }, [
    batchDeletionCapability,
    controller,
    registerInteractionLockProbe,
    runtime,
    workspaceId
  ]);
  useEffect(() => {
    controller.configure({
      conversationFilter,
      sectionAgentTargetFallbackId,
      userProjects
    });
    controller.setSearchQuery(conversationQuery);
  }, [
    controller,
    conversationFilter,
    conversationQuery,
    sectionAgentTargetFallbackId,
    userProjects
  ]);

  const querySnapshot = useEngineSelector(
    controller,
    identitySnapshot,
    Object.is
  );
  const requestedRailScopeKey = useMemo(
    () =>
      resolveConversationRailQueryScope(workspaceId, {
        conversationFilter,
        sectionAgentTargetFallbackId,
        userProjects
      }).scopeKey,
    [
      conversationFilter,
      sectionAgentTargetFallbackId,
      userProjects,
      workspaceId
    ]
  );
  return useMemo(
    () => ({
      ...querySnapshot,
      batchDeletionAvailable: batchDeletionCapability.available,
      isInteractionLocked: controller.isInteractionLocked,
      loadMoreSectionConversations: controller.loadMoreSectionConversations,
      railSearch: {
        ...querySnapshot.railSearch,
        loadMore: controller.loadMoreSearchResults,
        retry: controller.retrySearchResults
      },
      runtimeRailScopeResolved:
        !querySnapshot.runtimeSectionsEnabled ||
        querySnapshot.runtimeRailResolvedScopeKey === requestedRailScopeKey,
      runtimeRailConversations: querySnapshot.runtimeRailConversations
    }),
    [
      batchDeletionCapability.available,
      controller,
      querySnapshot,
      requestedRailScopeKey
    ]
  );
}

function identitySnapshot(
  snapshot: AgentGUIConversationRailQuerySnapshot
): AgentGUIConversationRailQuerySnapshot {
  return snapshot;
}
