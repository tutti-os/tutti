import { useEffect, useMemo, useRef } from "react";
import {
  useAgentGUIRuntime,
  type AgentGUIRuntime
} from "../../../agentActivityRuntime";
import {
  createAgentGUIConversationRailQueryController,
  type AgentGUIConversationRailQuerySnapshot,
  type ConversationRailQueryRuntime
} from "../../../agentConversationRailController";
import { inspectAgentConversationBatchDeletionCapability } from "./agentConversationBatchDeletionCapability";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import { createConversationRailConversationsSelector } from "./agentGuiConversationRailQuerySnapshot";
import { resolveConversationRailQueryScope } from "./agentGuiConversationRailQueryTypes";
import { reportAgentGUIConversationBatchDeletionCapabilityIncomplete } from "./agentGuiController.reporting";

export interface AgentGUIConversationRailInput {
  activeConversationId: string | null;
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  conversationQuery: string;
  nodeId?: string | null;
  registerInteractionLockProbe?: (probe: (() => boolean) | null) => void;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  workspaceId: string;
}

export function useAgentGUIConversationRailQuery({
  activeConversationId,
  conversationFilter,
  conversationQuery,
  nodeId,
  registerInteractionLockProbe,
  userProjects,
  workspaceId
}: AgentGUIConversationRailInput) {
  const runtime = useAgentGUIRuntime();
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
  const railRuntime = useMemo(
    () => createAgentGUIConversationRailRuntimeAdapter(runtime, nodeId),
    [nodeId, runtime]
  );
  const controller = useMemo(
    () =>
      createAgentGUIConversationRailQueryController({
        engine,
        getActiveConversationId: () => activeConversationIdRef.current,
        runtime: railRuntime,
        workspaceId
      }),
    [engine, railRuntime, workspaceId]
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
      userProjects
    });
    controller.setSearchQuery(conversationQuery);
  }, [controller, conversationFilter, conversationQuery, userProjects]);

  const querySnapshot = useEngineSelector(
    controller,
    identitySnapshot,
    Object.is
  );
  const projectRailConversations = useMemo(() => {
    const select = createConversationRailConversationsSelector();
    let previous: ReturnType<typeof select> = [];
    return (
      state: Parameters<typeof select>[0]["engineState"],
      snapshot: AgentGUIConversationRailQuerySnapshot
    ) => {
      previous = select(
        {
          engineState: state,
          interactionLocked: controller.isInteractionLocked(),
          querySnapshot: snapshot
        },
        previous
      );
      return previous;
    };
  }, [controller]);
  const runtimeRailConversations = useEngineSelector(
    engine,
    (state) => projectRailConversations(state, querySnapshot),
    Object.is
  );
  const requestedRailScopeKey = useMemo(
    () =>
      resolveConversationRailQueryScope(workspaceId, {
        conversationFilter,
        userProjects
      }).scopeKey,
    [conversationFilter, userProjects, workspaceId]
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
      runtimeRailConversations
    }),
    [
      batchDeletionCapability.available,
      controller,
      querySnapshot,
      requestedRailScopeKey,
      runtimeRailConversations
    ]
  );
}

function identitySnapshot(
  snapshot: AgentGUIConversationRailQuerySnapshot
): AgentGUIConversationRailQuerySnapshot {
  return snapshot;
}

function createAgentGUIConversationRailRuntimeAdapter(
  runtime: AgentGUIRuntime,
  nodeId: string | null | undefined
): ConversationRailQueryRuntime {
  const adapter: ConversationRailQueryRuntime = {};
  const listPinnedSessionsPage = runtime.listPinnedSessionsPage?.bind(runtime);
  if (listPinnedSessionsPage) {
    adapter.listPinnedSessionsPage = listPinnedSessionsPage;
  }
  const listSessionSectionPage = runtime.listSessionSectionPage?.bind(runtime);
  if (listSessionSectionPage) {
    adapter.listSessionSectionPage = listSessionSectionPage;
  }
  const listSessionSections = runtime.listSessionSections?.bind(runtime);
  if (listSessionSections) {
    adapter.listSessionSections = listSessionSections;
  }
  const listSessionsPage = runtime.listSessionsPage?.bind(runtime);
  if (listSessionsPage) {
    adapter.listSessionsPage = listSessionsPage;
  }
  const reportDiagnostic = runtime.reportDiagnostic?.bind(runtime);
  if (reportDiagnostic) {
    const normalizedNodeId = nodeId?.trim() || null;
    adapter.reportDiagnostic = (input) =>
      reportDiagnostic({
        ...input,
        details: {
          ...input.details,
          nodeId: normalizedNodeId
        }
      });
  }
  return adapter;
}
