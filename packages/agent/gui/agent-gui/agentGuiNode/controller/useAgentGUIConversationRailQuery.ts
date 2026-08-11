import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  selectAttentionReadState,
  selectRootAgentSessionIdsWithPendingInteractions,
  selectWorkspaceAgentConsumerSessions
} from "@tutti-os/agent-activity-core";
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
import {
  applyAgentGUIConversationProjects,
  type AgentGUIConversationSummary
} from "../model/agentGuiConversationModel";
import type { AgentGUIConversationActivityRootFact } from "../model/agentGuiConversationActivityView";
import {
  filterAgentGUIConversationSummaries,
  type AgentGUIConversationFilter
} from "../model/agentGuiConversationFilter";
import { createAgentGUIConversationRailTitlePromptSelector } from "../../../shared/agentConversationRailTitlePromptSelector";
import { projectCanonicalAgentGUIConversationSummaries } from "../../../shared/agentGUIConversationSummaryProjection";
import { selectRootAgentSessionIdsAwaitingPlanImplementation } from "../../../shared/agentConversation/planImplementationAwaiting";
import { conversationSummariesRenderEqual } from "./agentGuiController.stableHelpers";
import { createConversationRailConversationsSelector } from "./agentGuiConversationRailQuerySnapshot";
import { resolveConversationRailQueryScope } from "./agentGuiConversationRailQueryTypes";
import { agentGUIConversationRailViewScopeKey } from "../model/agentGuiConversationRailViewState";
import { reportAgentGUIConversationBatchDeletionCapabilityIncomplete } from "./agentGuiController.reporting";

export interface AgentGUIConversationRailInput {
  activeConversationId: string | null;
  activityContextKey?: string;
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  conversationQuery: string;
  currentUserId?: string | null;
  nodeId?: string | null;
  registerInteractionLockProbe?: (probe: (() => boolean) | null) => void;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  workspaceId: string;
}

const EMPTY_AGENT_GUI_CONVERSATION_ACTIVITY_ROOT_FACTS: ReadonlyMap<
  string,
  AgentGUIConversationActivityRootFact
> = new Map();
const EMPTY_AGENT_GUI_CONVERSATION_ACTIVITY_CONVERSATIONS: readonly AgentGUIConversationSummary[] =
  [];

export function useAgentGUIConversationRailQuery({
  activeConversationId,
  conversationFilter,
  conversationQuery,
  activityContextKey = "",
  currentUserId,
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
  const activityEnabled = runtime.conversationActivityViewEnabled === true;
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
        sectionRefreshLimitMax:
          runtime.conversationRailQueryLimits?.sectionRefreshLimitMax,
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
  const selectActivityRootFacts = useMemo(
    () =>
      runtime.conversationActivityViewEnabled === true
        ? selectAgentGUIConversationActivityRootFacts
        : selectEmptyAgentGUIConversationActivityRootFacts,
    [runtime.conversationActivityViewEnabled]
  );
  const activityRootFacts = useEngineSelector(
    engine,
    selectActivityRootFacts,
    activityRootFactsEqual
  );
  const selectActivityTitlePrompts = useMemo(
    () => createAgentGUIConversationRailTitlePromptSelector(),
    [engine]
  );
  const activityTitlePrompts = useEngineSelector(
    engine,
    selectActivityTitlePrompts,
    Object.is
  );
  const selectActivityConversations = useMemo(
    () => (state: Parameters<typeof selectWorkspaceAgentConsumerSessions>[0]) =>
      selectCanonicalActivityConversations(state, {
        activityEnabled,
        conversationFilter,
        currentUserId,
        firstUserDisplayPromptsBySessionId: activityTitlePrompts,
        userProjects
      }),
    [
      activityEnabled,
      activityTitlePrompts,
      conversationFilter,
      currentUserId,
      userProjects
    ]
  );
  const activityConversations = useEngineSelector(
    engine,
    selectActivityConversations,
    activityConversationArraysEqual
  );
  const deletedSessionIds = useEngineSelector(
    engine,
    (state) => state.sessionLifecycle.deletedSessionIds
  );
  useEffect(() => {
    controller.configure({
      conversationFilter,
      userProjects
    });
    controller.setSearchQuery(conversationQuery);
    controller.activityController.configure({
      available: activityEnabled,
      conversations: activityConversations,
      deletedSessionIds,
      identityKey: `${workspaceId}\u0000${activityContextKey}`,
      scopeKey: agentGUIConversationRailViewScopeKey({
        conversationFilter,
        workspaceId
      })
    });
  }, [
    activityContextKey,
    activityConversations,
    activityEnabled,
    controller,
    conversationFilter,
    conversationQuery,
    deletedSessionIds,
    userProjects,
    workspaceId
  ]);
  const requestedRailScopeKey = useMemo(
    () =>
      resolveConversationRailQueryScope(workspaceId, {
        conversationFilter,
        userProjects
      }).scopeKey,
    [conversationFilter, userProjects, workspaceId]
  );
  const retryRuntimeRail = useCallback(
    () => controller.refresh(),
    [controller]
  );
  return useMemo(
    () => ({
      ...querySnapshot,
      activityController: controller.activityController,
      batchDeletionAvailable: batchDeletionCapability.available,
      activityRootFacts,
      activityConversations,
      deletedSessionIds,
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
      runtimeRailConversations,
      retryRuntimeRail
    }),
    [
      batchDeletionCapability.available,
      activityRootFacts,
      activityConversations,
      controller,
      deletedSessionIds,
      querySnapshot,
      requestedRailScopeKey,
      runtimeRailConversations,
      retryRuntimeRail
    ]
  );
}

function selectEmptyAgentGUIConversationActivityRootFacts(): ReadonlyMap<
  string,
  AgentGUIConversationActivityRootFact
> {
  return EMPTY_AGENT_GUI_CONVERSATION_ACTIVITY_ROOT_FACTS;
}

function selectAgentGUIConversationActivityRootFacts(
  state: Parameters<typeof selectWorkspaceAgentConsumerSessions>[0]
): ReadonlyMap<string, AgentGUIConversationActivityRootFact> {
  const rootSessionIdsAwaitingUserAction = new Set([
    ...selectRootAgentSessionIdsWithPendingInteractions(state),
    ...selectRootAgentSessionIdsAwaitingPlanImplementation(state)
  ]);
  return new Map(
    selectWorkspaceAgentConsumerSessions(state)
      .filter((item) => item.session.visible !== false)
      .map((item) => [
        item.session.agentSessionId,
        {
          needsUserAction: rootSessionIdsAwaitingUserAction.has(
            item.session.agentSessionId
          ),
          status: item.displayStatus === "idle" ? "ready" : item.displayStatus
        }
      ])
  );
}

function selectCanonicalActivityConversations(
  state: Parameters<typeof selectWorkspaceAgentConsumerSessions>[0],
  input: {
    activityEnabled: boolean;
    conversationFilter: AgentGUIConversationFilter;
    currentUserId?: string | null;
    firstUserDisplayPromptsBySessionId: Record<string, string>;
    userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  }
): readonly AgentGUIConversationSummary[] {
  if (!input.activityEnabled) {
    return EMPTY_AGENT_GUI_CONVERSATION_ACTIVITY_CONVERSATIONS;
  }
  const rootFacts = selectAgentGUIConversationActivityRootFacts(state);
  const attention = selectAttentionReadState(state, input.currentUserId);
  const summaries = projectCanonicalAgentGUIConversationSummaries(
    selectWorkspaceAgentConsumerSessions(state),
    input.firstUserDisplayPromptsBySessionId
  ).map((conversation): AgentGUIConversationSummary => {
    const fact = rootFacts.get(conversation.id);
    const attentionRecord = attention.recordsBySessionId[conversation.id];
    return {
      ...conversation,
      hasUnreadCompletion: attentionRecord?.isUnread ?? false,
      needsUserAction: fact?.needsUserAction ?? conversation.needsUserAction,
      status: fact?.status ?? conversation.status
    };
  });
  return filterAgentGUIConversationSummaries(
    applyAgentGUIConversationProjects(summaries, input.userProjects),
    input.conversationFilter
  );
}

function activityConversationArraysEqual(
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

function activityRootFactsEqual(
  left: ReadonlyMap<string, AgentGUIConversationActivityRootFact>,
  right: ReadonlyMap<string, AgentGUIConversationActivityRootFact>
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([id, fact]) => {
      const candidate = right.get(id);
      return (
        candidate?.needsUserAction === fact.needsUserAction &&
        candidate.status === fact.status
      );
    })
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
