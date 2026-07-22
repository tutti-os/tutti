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
  previewMode: boolean;
  /**
   * Lets the host subtree observe this controller's interaction lock (e.g.
   * so header-dispatched session actions honor the same lock as the rail).
   */
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
  previewMode,
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
      previewMode,
      sectionAgentTargetFallbackId,
      userProjects
    });
    controller.setSearchQuery(conversationQuery);
  }, [
    controller,
    conversationFilter,
    conversationQuery,
    previewMode,
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
        previewMode,
        sectionAgentTargetFallbackId,
        userProjects
      }).scopeKey,
    [
      conversationFilter,
      previewMode,
      sectionAgentTargetFallbackId,
      userProjects,
      workspaceId
    ]
  );
  return useMemo(
    () => ({
      ...querySnapshot,
      batchDeletionAvailable: !previewMode && batchDeletionCapability.available,
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
      previewMode,
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
