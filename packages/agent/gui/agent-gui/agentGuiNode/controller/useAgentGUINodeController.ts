import { selectWorkspaceAgentConsumerSessions } from "@tutti-os/agent-activity-core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAgentHostApi } from "../../../agentActivityHost";
import {
  useAgentActivityRuntime,
  useAgentActivitySnapshot
} from "../../../agentActivityRuntime";
import { useAccountStore } from "../../../host/agentHostAccountStore";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import type {
  AgentGUINodeData,
  AgentGUIProvider,
  AgentGUIProviderRailMode,
  AgentGUIProviderReadinessGate,
  AgentGUIAgentTarget
} from "../../../types";
import type { AgentGUIDetailViewModel } from "../model/agentGuiNodeTypes";
import {
  AGENT_GUI_RUNTIME_SESSION_ORIGIN,
  conversationSummaryFromAgentSession,
  type AgentGUIConversationSummary
} from "../model/agentGuiConversationModel";
import { normalizeProjectDraftPath } from "./agentGuiController.composerHelpers";
import { mergeVisibleConversations } from "./agentGuiController.conversationHelpers";
import {
  reuseAgentActivityDisplayStatusesIfUnchanged,
  type AgentGUIOpenSessionRequest
} from "./agentGuiController.draftMessageHelpers";
import {
  getAgentGUIErrorCode,
  getAgentGUIErrorMessage
} from "./agentGuiController.errors";
import {
  areAgentGUIUserProjectsEqual,
  readAgentGUIUserProjectSnapshot,
  upsertAgentGUIUserProject
} from "./agentGuiController.interactiveHelpers";
import {
  EMPTY_AGENT_GUI_MESSAGES,
  composerTargetDataFromProviderTarget,
  isExplicitAgentGUIAgentTarget,
  type AgentGUIRememberComposerDefaultsInput
} from "./agentGuiController.providerHelpers";
import { reportAgentGUIActiveConversationCleared } from "./agentGuiController.reporting";
import { useAgentGUIActivation } from "./useAgentGUIActivation";
import { useAgentGUIActiveMessages } from "./useAgentGUIActiveMessages";
import type { AgentGUIPrefillPromptRequest } from "./useAgentGUIConversationHome";
import { useAgentGUIConversationRouting } from "./useAgentGUIConversationRouting";
import { useAgentGUIConversationSelectionController } from "./useAgentGUIConversationSelectionController";
import { useAgentGUIConversationListState } from "./useAgentGUIConversationListState";
import { useAgentGUIComposerCapabilities } from "./useAgentGUIComposerCapabilities";
import { useAgentGUIComposerOptionsSync } from "./useAgentGUIComposerOptionsSync";
import { useAgentGUIControllerRefs } from "./useAgentGUIControllerRefs";
import { useAgentGUIOperationActions } from "./useAgentGUIOperationActions";
import { useAgentGUIViewAssembly } from "./useAgentGUIViewAssembly";
import { useAgentGUIProviderCatalogSelection } from "./useAgentGUIProviderCatalogSelection";
import { useAgentGUISessionEngineState } from "./useAgentGUISessionEngineState";
import { useAgentGUISessionDetailTransport } from "./useAgentGUISessionDetailTransport";
import { useAgentGUILocalState } from "./useAgentGUILocalState";
export {
  normalizePermissionModeSemantic,
  permissionConfigFromComposerOptions,
  permissionModeDescription,
  permissionModeLabel,
  permissionModeOptions
} from "./agentGuiController.composerHelpers";
export * from "./agentGuiController.conversationHelpers";
export {
  agentGUIConversationDiagnosticDetails,
  agentGUIRuntimeSessionDiagnosticDetails,
  agentGUISessionStateDiagnosticDetails,
  agentGUIToolCallStatusIsWaiting,
  promptRequestId
} from "./agentGuiController.diagnostics";
export * from "./agentGuiController.draftMessageHelpers";
export * from "./agentGuiController.errors";
export {
  createAgentGUIConversationId,
  normalizeOptionalPrompt,
  normalizeOptionalText,
  projectAgentGUIMessagesToTimelineItems,
  recordValue,
  stringPayloadValue
} from "./agentGuiController.promptHelpers";
export * from "./agentGuiController.providerHelpers";
export * from "./agentGuiController.reporting";
export {
  messageFromMessageUpdate,
  normalizeTimelineStatus,
  normalizedPositiveNumber,
  timelineItemTime
} from "./agentGuiController.sessionHelpers";
export * from "./agentGuiController.stableHelpers";
export {
  filterMessagesForDetailWindowOverlay,
  maxFiniteMessageVersion,
  minFiniteMessageVersion,
  sessionHasRenderableMessages,
  sessionViewHasUnhydratedOlderDetailMessages,
  windowHasTurnMissingUserPrompt
} from "./useAgentConversationMessagePaging";
export { resolveConversationSummaryById } from "./useAgentConversationSelection";
export type { ConversationIntent } from "./useAgentConversationSelection";

interface UseAgentGUINodeControllerInput {
  nodeId?: string;
  workspaceId: string;
  currentUserId?: string | null;
  workspacePath: string;
  avoidGroupingEdits: boolean;
  data: AgentGUINodeData;
  agentTargets?: readonly AgentGUIAgentTarget[];
  agentTargetsLoading?: boolean;
  providerRailMode?: AgentGUIProviderRailMode;
  comingSoonProviders?: readonly AgentGUIProvider[];
  providerReadinessGates?: Partial<
    Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>
  > | null;
  defaultAgentTargetId?: string | null;
  openSessionRequest?: AgentGUIOpenSessionRequest | null;
  prefillPromptRequest?: AgentGUIPrefillPromptRequest | null;
  previewMode?: boolean;
  onDataChange: (
    updater: (current: AgentGUINodeData) => AgentGUINodeData
  ) => void;
  onRememberComposerDefaults?: (
    input: AgentGUIRememberComposerDefaultsInput
  ) => void | Promise<void>;
  onShowMessage?: (
    message: string,
    tone?: "info" | "warning" | "error"
  ) => void;
}

export type { AgentGUIOpenSessionRequest } from "./agentGuiController.draftMessageHelpers";
export type { AgentGUIPrefillPromptRequest } from "./useAgentGUIConversationHome";

export function useAgentGUINodeController({
  workspaceId,
  currentUserId,
  workspacePath,
  avoidGroupingEdits,
  data,
  agentTargets,
  agentTargetsLoading = false,
  providerRailMode = "catalog",
  comingSoonProviders,
  providerReadinessGates = null,
  defaultAgentTargetId = null,
  openSessionRequest = null,
  prefillPromptRequest = null,
  previewMode = false,
  onDataChange,
  onRememberComposerDefaults,
  onShowMessage
}: UseAgentGUINodeControllerInput) {
  const agentActivityRuntime = useAgentActivityRuntime();
  const agentActivityRuntimeOrigin =
    agentActivityRuntime.origin?.trim() || AGENT_GUI_RUNTIME_SESSION_ORIGIN;
  const sessionEngine = useMemo(() => {
    const engine = agentActivityRuntime.getSessionEngine(workspaceId);
    if (
      engine.identity.workspaceId !== workspaceId ||
      engine.identity.origin !== agentActivityRuntimeOrigin
    ) {
      throw new Error(
        "Agent activity runtime returned a session engine for a different identity."
      );
    }
    return engine;
  }, [agentActivityRuntime, agentActivityRuntimeOrigin, workspaceId]);
  // Stable runtime identity isolates conversation queries and session-view refs.
  const agentHostApi = useAgentHostApi();
  const agentActivitySnapshot = useAgentActivitySnapshot(workspaceId);
  const providerCatalogSelection = useAgentGUIProviderCatalogSelection({
    comingSoonProviders,
    data,
    defaultAgentTargetId,
    providerRailMode,
    providerReadinessGates,
    agentTargets,
    agentTargetsLoading
  });
  const {
    effectiveSelectedProviderTarget,
    homeComposerTargetOverride,
    normalizedComingSoonProviders,
    normalizedExplicitProviderTargets,
    normalizedProviderTargets,
    selectedComposerTargetData,
    selectedAgentTargetIsExplicit,
    setHomeComposerTargetOverride
  } = providerCatalogSelection;
  const agentActivityDisplayStatuses = useEngineSelector(
    sessionEngine,
    (state) =>
      new Map(
        selectWorkspaceAgentConsumerSessions(state).map((item) => [
          item.session.agentSessionId,
          item.displayStatus
        ])
      ),
    (left, right) =>
      reuseAgentActivityDisplayStatusesIfUnchanged(left, right) === left
  );
  const localState = useAgentGUILocalState({
    data,
    userProjectsApi: agentHostApi.userProjects
  });
  const {
    activeConversationId,
    draftBySessionId,
    draftSettingsBySessionId,
    intent,
    isComposerHome,
    selectedProjectPath,
    setActiveConversationId,
    setDetailError,
    setIntent,
    setIsComposerHome,
    setIsLoadingMessages,
    setSelectedProjectPath,
    setUserProjects,
    userProjects
  } = localState;
  const conversationList = useAgentGUIConversationListState({
    agentActivityRuntimeOrigin,
    agentActivitySnapshot,
    currentUserId,
    data,
    normalizedProviderTargets,
    sessionEngine,
    workspaceId
  });
  const {
    attentionReadState,
    conversationFilter,
    conversationListQuery,
    conversationListState,
    conversations,
    pendingNewActivationProjection
  } = conversationList;
  const isNoProjectPath = agentHostApi.userProjects?.isNoProjectPath;
  const hasLoadedConversations = conversationListState?.initialized ?? false;
  const isLoadingConversations = conversationListState?.isLoading ?? false;
  const sessionEngineState = useAgentGUISessionEngineState({
    activeConversationId,
    sessionEngine
  });
  const {
    activeEngineSession,
    activePendingActivation,
    activePendingSubmits,
    activeQueuedPrompts,
    activeSessionState,
    hasPendingNewActivation
  } = sessionEngineState;
  const latestPendingNewActivation = pendingNewActivationProjection;
  const isCreatingConversation = hasPendingNewActivation;
  // Bridges submitInteractivePrompt
  // updateComposerSettings (defined later); assigned right after the
  // callback's definition.
  const updateComposerSettingsRef = useRef<
    (nextSettings: Partial<AgentSessionComposerSettings>) => void
  >(() => {});
  // Bridges submitInteractivePrompt (defined earlier) to the client-side plan
  // decision handlers (defined later); assigned after those callbacks.
  const planActionsRef = useRef<{
    implement: () => void;
    feedback: (text: string) => void;
    skip: () => void;
  }>({ implement: () => {}, feedback: () => {}, skip: () => {} });
  const composerCapabilities = useAgentGUIComposerCapabilities({
    activeConversationId,
    activeEngineSession,
    activeSessionState,
    agentActivitySnapshot,
    data,
    draftSettingsBySessionId,
    selectedComposerTargetData
  });
  const {
    composerSupport,
    composerTargetData,
    defaultReasoningEffort,
    providerComposerOptions
  } = composerCapabilities;
  const planImplementationTurnIdRef = useRef<string | null>(null);
  const accountProfilesByUserId = useAccountStore(
    (state) => state.profilesByUserId
  );
  const controllerRefs = useAgentGUIControllerRefs({
    activeConversationId,
    agentActivitySnapshot,
    conversations,
    data,
    draftBySessionId,
    draftSettingsBySessionId,
    effectiveSelectedProviderTarget,
    homeComposerTargetOverride,
    isComposerHome,
    isCreatingConversation,
    isNoProjectPath,
    onDataChange,
    onRememberComposerDefaults,
    onShowMessage,
    agentTargetsProvided: agentTargets !== undefined,
    selectedComposerTargetData,
    selectedProjectPath,
    selectedAgentTargetIsExplicit,
    userProjects
  });
  const {
    activeConversationIdRef,
    agentActivitySnapshotRef,
    composerOptionsProjectKeyRef,
    conversationIdsRef,
    conversationsRef,
    dataRef,
    draftSettingsBySessionIdRef,
    handledOpenSessionSequenceRef,
    isComposerHomeRef,
    isMountedRef,
    loadDraftComposerOptionsRef,
    onDataChangeRef,
    pendingOpenSessionRequestRef,
    reloadSelectedConversationRef,
    selectedComposerTargetDataRef,
    selectedProjectPathRef,
    syncConversationListProjectionRef,
    userProjectsLoadSeqRef,
    userProjectsRef
  } = controllerRefs;
  const sessionDetailTransport = useAgentGUISessionDetailTransport({
    activeConversationId,
    activeConversationIdRef,
    agentActivityRuntime,
    agentActivityRuntimeOrigin,
    agentActivitySnapshot,
    agentActivitySnapshotRef,
    dataRef,
    isMountedRef,
    reloadSelectedConversationRef,
    sessionEngine,
    syncConversationListProjectionRef,
    workspaceId
  });
  const {
    loadSessionState,
    markSelectedConversationDetailPending,
    reloadSelectedConversation,
    resolveSessionMessages
  } = sessionDetailTransport;
  const storedActiveMessages = activeConversationId
    ? resolveSessionMessages(activeConversationId)
    : EMPTY_AGENT_GUI_MESSAGES;
  const { activeMessages, activeTimelineItems } = useAgentGUIActiveMessages({
    activeConversationId,
    activePendingActivation,
    activePendingSubmits,
    activeQueuedPrompts,
    currentUserId,
    storedMessages: storedActiveMessages,
    workspaceId
  });
  const transientConversation =
    useMemo<AgentGUIConversationSummary | null>(() => {
      const session = activeEngineSession;
      if (
        !session ||
        session.visible === false ||
        conversations.some(
          (conversation) => conversation.id === session.agentSessionId
        )
      ) {
        return null;
      }
      return conversationSummaryFromAgentSession(session, {
        isNoProjectPath,
        userProjects
      });
    }, [
      activeEngineSession,
      agentActivityDisplayStatuses,
      conversations,
      isNoProjectPath,
      userProjects
    ]);
  // Stashes the error message from a failed first-message create so the
  // activeConversationId-null effect (which otherwise clears detailError on
  // every home transition) can surface it on the home composer instead of
  // wiping it out during the optimistic-entry revert.
  const activation = useAgentGUIActivation({
    engine: sessionEngine,
    workspaceId,
    getErrorMessage: getAgentGUIErrorMessage,
    getErrorCode: getAgentGUIErrorCode
  });
  const activeConversationLiveState = activation.stateFor(activeConversationId);
  const removeConversations = useCallback(
    (conversationIds: readonly string[]) => {
      for (const agentSessionId of conversationIds) {
        sessionEngine.dispatch({
          type: "session/removed",
          agentSessionId
        });
      }
    },
    [sessionEngine]
  );

  const setUserProjectsSnapshot = useCallback(
    (projects: readonly AgentHostUserProject[]) => {
      setUserProjects((current) =>
        areAgentGUIUserProjectsEqual(current, projects)
          ? current
          : [...projects]
      );
    },
    []
  );

  useEffect(() => {
    const api = agentHostApi.userProjects;
    let disposed = false;
    setUserProjectsSnapshot(readAgentGUIUserProjectSnapshot(api));
    const loadUserProjects = async () => {
      const requestSeq = ++userProjectsLoadSeqRef.current;
      if (!api) {
        if (!disposed && requestSeq === userProjectsLoadSeqRef.current) {
          setUserProjectsSnapshot([]);
        }
        return;
      }
      try {
        const result = await api.list();
        if (!disposed && requestSeq === userProjectsLoadSeqRef.current) {
          setUserProjectsSnapshot(result.projects);
        }
      } catch {
        if (!disposed && requestSeq === userProjectsLoadSeqRef.current) {
          setUserProjectsSnapshot([]);
        }
      }
    };
    void loadUserProjects();
    const unsubscribe = previewMode
      ? undefined
      : api?.subscribe?.(() => {
          void loadUserProjects();
        });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [agentHostApi.userProjects, previewMode, setUserProjectsSnapshot]);

  // NOTE: project metadata is intentionally NOT written back into the shared
  // conversation store. `conversation.project` is a per-window JOIN of cwd ×
  // userProjects; deriving it here and persisting it caused cross-window update
  // storms. It is now derived in the view layer (groupConversations) instead.

  useEffect(() => {
    if (activeConversationId === null && isComposerHome) {
      return;
    }
    setHomeComposerTargetOverride(null);
  }, [activeConversationId, isComposerHome]);

  const conversationSelection = useAgentGUIConversationSelectionController({
    activation,
    activeConversationId,
    activeConversationIdRef,
    activePendingActivation,
    agentActivityRuntime,
    agentActivitySnapshotRef,
    attentionReadRecordsBySessionId: attentionReadState.recordsBySessionId,
    conversationIdsRef,
    conversationListQuery,
    currentUserId,
    data,
    dataRef,
    intent,
    isComposerHomeRef,
    isMountedRef,
    latestPendingNewActivation,
    loadDraftComposerOptions: () => loadDraftComposerOptionsRef.current(),
    markSelectedConversationDetailPending,
    onDataChangeRef,
    reloadSelectedConversationRef,
    sessionEngine,
    setActiveConversationId,
    setDetailError,
    setIntent,
    setIsComposerHome,
    setIsLoadingMessages,
    workspaceId
  });
  const persistActiveConversation =
    conversationSelection.persistActiveConversation;
  const selectConversation = conversationSelection.selectConversation;
  const syncConversationListProjection =
    conversationSelection.syncConversationListProjection;
  syncConversationListProjectionRef.current = syncConversationListProjection;

  const updateSelectedProjectPath = useCallback(
    (
      path: string | null,
      metadata?: {
        action: "clear" | "create_new" | "select_existing";
        project?: {
          id: string;
          path: string;
          label: string;
          createdAtUnixMs?: number;
          updatedAtUnixMs?: number;
          lastUsedAtUnixMs?: number | null;
        };
      }
    ) => {
      const normalizedPath = normalizeProjectDraftPath(path);
      const project = metadata?.project;
      if (project && normalizedPath && project.path === normalizedPath) {
        const nextProjects = upsertAgentGUIUserProject(
          userProjectsRef.current,
          project
        );
        userProjectsRef.current = nextProjects;
        setUserProjectsSnapshot(nextProjects);
      }
      selectedProjectPathRef.current = normalizedPath;
      setSelectedProjectPath(normalizedPath);
      const agentSessionId = activeConversationIdRef.current;
      if (!agentSessionId || !metadata) {
        return;
      }
      const tracking = agentActivityRuntime.trackSettingsProjectChange?.({
        action: metadata.action,
        agentSessionId,
        provider: dataRef.current.provider,
        workspaceId
      });
      void tracking?.catch(() => {});
    },
    [agentActivityRuntime, workspaceId]
  );

  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!hasLoadedConversations) {
      return;
    }
    const nextConversationCount = mergeVisibleConversations(
      conversations,
      transientConversation
    ).length;
    onDataChangeRef.current((current) =>
      current.conversationCount === nextConversationCount
        ? current
        : { ...current, conversationCount: nextConversationCount }
    );
  }, [
    conversations.length,
    hasLoadedConversations,
    previewMode,
    transientConversation
  ]);

  useAgentGUIConversationRouting({
    activeConversationIdRef,
    conversationListQuery,
    conversations,
    conversationsRef,
    handledOpenSessionSequenceRef,
    hasLoadedConversations,
    intent,
    openSessionRequest,
    pendingOpenSessionRequestRef,
    previewMode,
    selectConversation,
    sessionEngine,
    setIntent,
    syncConversationListProjection,
    transientConversation,
    workspaceId
  });

  const { loadComposerOptionsForTarget, loadDraftComposerOptions } =
    useAgentGUIComposerOptionsSync({
      activeConversationId,
      activeConversationIdRef,
      agentActivityRuntime,
      composerOptionsProjectKeyRef,
      composerTargetData,
      conversationFilter,
      currentUserId,
      data,
      dataRef,
      defaultReasoningEffort,
      draftSettingsBySessionIdRef,
      isComposerHome,
      isComposerHomeRef,
      isCreatingConversation,
      loadDraftComposerOptionsRef,
      loadSessionState,
      previewMode,
      providerComposerOptions,
      reloadSelectedConversation,
      selectedComposerTargetDataRef,
      selectedProjectPath,
      selectedProjectPathRef,
      sessionEngine,
      syncConversationListProjection,
      workspaceId,
      workspacePath
    });
  const operationActions = useAgentGUIOperationActions({
    ...providerCatalogSelection,
    ...localState,
    ...conversationList,
    ...sessionEngineState,
    ...composerCapabilities,
    ...controllerRefs,
    ...sessionDetailTransport,
    ...conversationSelection,
    accountProfilesByUserId,
    activation,
    agentActivityRuntime,
    agentHostApi,
    composerTargetDataFromProviderTarget,
    composerSupportPermissionModeChangeDeferred:
      composerSupport.permissionModeChangeDeferred,
    currentProvider: data.provider,
    currentUserId,
    data,
    defaultAgentTargetId,
    isExplicitAgentGUIAgentTarget,
    latestPendingNewActivation,
    loadDraftComposerOptions,
    normalizedExplicitProviderTargets,
    normalizedProviderTargets,
    planActionsRef,
    planImplementationTurnIdRef,
    prefillPromptRequest,
    previewMode,
    removeConversations,
    reportActiveConversationCleared: reportAgentGUIActiveConversationCleared,
    sessionEngine,
    setUserProjectsSnapshot,
    transientConversation,
    unactivate: activation.unactivate,
    updateComposerSettingsRef,
    workspaceId
  });
  const isLoadingMessages =
    localState.isLoadingMessages ||
    sessionEngineState.activeSessionReconcilePending;
  const detailAvailability: AgentGUIDetailViewModel["availability"] =
    activeConversationId === null
      ? "ready"
      : sessionEngineState.activeEngineSessionDeleted
        ? "not_found"
        : isLoadingMessages
          ? "loading"
          : sessionEngineState.activeSessionReconcileError ||
              localState.detailError
            ? "error"
            : "ready";
  return useAgentGUIViewAssembly({
    ...providerCatalogSelection,
    ...localState,
    ...conversationList,
    ...sessionEngineState,
    ...composerCapabilities,
    ...controllerRefs,
    ...sessionDetailTransport,
    ...conversationSelection,
    ...operationActions,
    activeCancelStatus: sessionEngineState.activeCancelState?.status ?? null,
    activePendingInteractions:
      sessionEngineState.activeEnginePendingInteractions,
    activeTurn: sessionEngineState.activeEngineActiveTurn,
    activeLatestPendingSubmitTurnId:
      sessionEngineState.activeLatestPendingSubmit?.turnId ?? null,
    activeMessages,
    activeTimelineItems,
    activeConversationLiveState,
    activationState: activeConversationLiveState,
    activityDisplayStatus: activeConversationId
      ? (agentActivityDisplayStatuses.get(activeConversationId) ?? null)
      : null,
    activityDisplayStatuses: agentActivityDisplayStatuses,
    agentActivityRuntime,
    avoidGroupingEdits,
    currentUserId,
    codeFor: activation.codeFor,
    composerTargetProvider: composerTargetData.provider,
    conversationListInitialized: conversationListState?.initialized === true,
    data,
    defaultAgentTargetId,
    errorFor: activation.errorFor,
    detailAvailability,
    isCreatingConversation,
    isLoadingConversations,
    isLoadingMessages,
    loadComposerOptionsForTarget,
    latestPendingNewActivation,
    normalizedComingSoonProviders,
    operationActions,
    persistActiveConversation,
    planImplementationTurnIdRef,
    previewMode,
    providerRailMode,
    providerReadinessGates,
    agentTargetsLoading,
    selectedComposerTargetData,
    sessionEngine,
    transientConversation,
    unactivate: activation.unactivate,
    updateSelectedProjectPath,
    userProjects,
    workspaceId,
    workspacePath
  });
}
