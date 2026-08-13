import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@tutti-os/ui-system/components";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import { matchesAgentGUIConversationSummaryFilter } from "../model/agentGuiConversationFilter";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import { showAgentGUIControllerErrorToast } from "../controller/agentGuiController.reporting";
import {
  isConversationRailInitialLoadPending,
  projectConversationRailMemberships,
  projectConversationRailSectionsByExactKey,
  projectConversationRailSearchSections,
  projectConversationRailSectionsWithActiveConversation,
  projectConversationRailSectionsWithTransientConversations,
  conversationRailSectionActiveConversationId,
  conversationRailSectionHeaderVisibility,
  isConversationRailProjectPinned,
  resolveConversationRailActiveConversation,
  stabilizeConversationSectionItems,
  stabilizeConversationSections
} from "../model/agentGuiConversationRail";
import { preserveConversationRailSectionTemplates } from "../model/agentGuiConversationRailSectionTemplates";
import { agentGUIConversationRailViewScopeKey } from "../model/agentGuiConversationRailViewState";
import type { useAgentGUIConversationRailQuery } from "../controller/useAgentGUIConversationRailQuery";
import { useAgentGUIProjectDrag } from "../controller/useAgentGUIProjectDrag";
import { AgentGUIConversationRailSection } from "./AgentGUIConversationRailSection";
import { AgentGUIConversationActivityView } from "./AgentGUIConversationActivityView";
import { AgentGUIConversationRailToolbar } from "./AgentGUIConversationRailToolbar";
import { AgentGUIConversationRailContentState } from "./AgentGUIConversationRailContentState";
import { AgentGUIConversationRailSectionPresentationProvider } from "./agentGUIConversationRailSectionPresentationContext";
import { AgentGUIProjectActionConfirmationDialog } from "./AgentGUIProjectActionConfirmationDialog";
import { AgentGUIProjectRailHeader } from "./AgentGUIConversationRailItem";
import {
  agentGuiPerfNowMs,
  conversationPlainTitle,
  roundAgentGuiPerfMs
} from "./agentGUIViewUtils";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import styles from "../AgentGUINode.styles";
import { useAgentGUIConversationRailViewState } from "./useAgentGUIConversationRailViewState";
import { useAgentGUIProjectMenuState } from "./useAgentGUIProjectMenuState";
import { useAgentGUIConversationActivityView } from "../controller/useAgentGUIConversationActivityView";
import { useDelayedBoolean } from "../controller/useDelayedBoolean";
import type {
  AgentGUIConversationFilterTargetSelection,
  AgentGUIProjectActionDialog
} from "./agentGUIConversationRailTypes";
import { useAgentGUIConversationRailBatchDeletion } from "./useAgentGUIConversationRailBatchDeletion";
export type { AgentGUIProjectActionDialog } from "./agentGUIConversationRailTypes";
export interface AgentGUIConversationRailControllerProps {
  activityContextKey?: string;
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  currentUserId?: string | null;
  nodeId?: string | null;
  footer?: React.ReactNode;
  workspaceId: string;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
  activeConversationId: string | null;
  revealRequest: AgentGUINodeViewModel["rail"]["revealRequest"];
  pendingDeleteConversationId: string | null;
  isLoadingConversations: boolean;
  isDeletingConversation: boolean;
  isDeletingProjectConversations: boolean;
  isUserProjectMutationPending?: boolean;
  labels: AgentGUIConversationRailLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  uiLanguage: UiLanguage;
  createConversationDisabled: boolean;
  isCollapsed: boolean;
  agentTargets: AgentGUINodeViewModel["rail"]["agentTargets"];
  agentTargetsLoading: AgentGUINodeViewModel["rail"]["agentTargetsLoading"];
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  /**
   * Lets the host subtree observe the rail query controller's interaction
   * lock (e.g. so header-dispatched session actions honor the same lock).
   */
  registerInteractionLockProbe?: (probe: (() => boolean) | null) => void;
  onUpdateConversationFilter: (
    filter: AgentGUINodeViewModel["rail"]["conversationFilter"]
  ) => void;
  onSelectConversationFilterTarget: AgentGUIConversationFilterTargetSelection;
  onCreateConversation: (options?: {
    projectPath?: string | null;
    source?: string;
  }) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenProjectFiles?: ((action: WorkspaceLinkAction) => void) | null;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRemoveProject: (path: string) => Promise<boolean>;
  onMoveProject: (
    projectId: string,
    beforeProjectId: string | null
  ) => Promise<void>;
  onToggleProjectPinned: (projectId: string, pinned: boolean) => Promise<void>;
  onConfirmDeleteProjectConversations: (
    sectionKey?: string,
    agentTargetId?: string | null
  ) => Promise<string[]>;
  onConfirmDeleteConversations: (agentSessionIds: string[]) => Promise<boolean>;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (
    conversation: AgentGUINodeViewModel["rail"]["conversations"][number]
  ) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
}

export type AgentGUIConversationRailPaneProps =
  AgentGUIConversationRailControllerProps & {
    conversationQuery: string;
    onConversationQueryChange: (query: string) => void;
    railQuery: ReturnType<typeof useAgentGUIConversationRailQuery>;
  };

type AgentGUIConversationRailDataProps = Pick<
  AgentGUIConversationRailControllerProps,
  "conversations" | "userProjects" | "workspaceId"
>;

export type AgentGUIConversationRailState = Omit<
  AgentGUIConversationRailControllerProps,
  keyof AgentGUIConversationRailDataProps
>;

export const AgentGUIConversationRailPane = memo(
  function AgentGUIConversationRailPane({
    conversations,
    footer,
    workspaceId,
    userProjects,
    activeConversation,
    activeConversationId,
    revealRequest,
    pendingDeleteConversationId,
    isLoadingConversations,
    isDeletingConversation,
    isDeletingProjectConversations,
    isUserProjectMutationPending = false,
    labels,
    workspaceUserProjectI18n,
    uiLanguage,
    createConversationDisabled,
    isCollapsed,
    conversationFilter,
    conversationQuery,
    railQuery,
    onCreateConversation,
    onSelectConversation,
    onToggleConversationPinned,
    onMarkConversationUnread,
    onOpenProjectFiles,
    onOpenConversationWindow,
    selectProjectDirectory,
    onRemoveProject,
    onMoveProject,
    onToggleProjectPinned,
    onConfirmDeleteProjectConversations,
    onConfirmDeleteConversations,
    onRequestDeleteConversation,
    onRequestRenameConversation,
    onCancelDeleteConversation,
    onConfirmDeleteConversation,
    onConversationQueryChange
  }: AgentGUIConversationRailPaneProps): React.JSX.Element {
    "use memo";
    const agentHostApi = useOptionalAgentHostApi();
    const [pendingProjectAction, setPendingProjectAction] =
      useState<AgentGUIProjectActionDialog | null>(null);
    const [isRequestingBatchDeletion, setIsRequestingBatchDeletion] =
      useState(false);
    const { railSearch } = railQuery;
    const railElementRef = useRef<HTMLElement | null>(null);
    const railFailureToastShownRef = useRef(false);
    const railActiveConversationRef = useRef<
      AgentGUINodeViewModel["rail"]["conversations"]
    >([]);
    const groupedConversationsRef = useRef<ConversationSection[] | null>(null);
    const {
      batchDeletionAvailable,
      deletedSessionIds,
      loadMoreSectionConversations,
      isInteractionLocked,
      runtimeSectionsEnabled,
      runtimeRailConversations,
      runtimeRailMemberships,
      runtimeRailReconcilingSessionIds,
      runtimeRailScopeResolved,
      runtimeRailSectionsPending,
      sectionPageStates
    } = railQuery;
    const { isProjectActionLocked, onProjectMenuOpenChange, projectMenuOpen } =
      useAgentGUIProjectMenuState(
        isInteractionLocked,
        isUserProjectMutationPending
      );
    const projectActionLocked = isProjectActionLocked();
    const railConversationEntitiesById = new Map(
      runtimeRailConversations.map((conversation) => [
        conversation.id,
        conversation
      ])
    );
    for (const conversation of conversations) {
      railConversationEntitiesById.set(conversation.id, conversation);
    }
    const railConversationEntities = [...railConversationEntitiesById.values()];
    const hasConversationQuery = conversationQuery.trim().length > 0;
    const railViewScopeKey = agentGUIConversationRailViewScopeKey({
      conversationFilter,
      workspaceId
    });
    const activityView = useAgentGUIConversationActivityView({
      activityController: railQuery.activityController,
      conversations: railQuery.activityConversations,
      deletedSessionIds,
      hasConversationQuery
    });
    const backendSearchActive = hasConversationQuery && railSearch.enabled;
    const railInteractionsLocked = isInteractionLocked();
    const projectDragBaseLocked =
      railInteractionsLocked ||
      isDeletingConversation ||
      isDeletingProjectConversations ||
      isRequestingBatchDeletion ||
      isUserProjectMutationPending ||
      pendingDeleteConversationId !== null ||
      pendingProjectAction !== null ||
      projectMenuOpen;
    const backendSearchConversations = backendSearchActive
      ? railSearch.sessionIds.flatMap((id) => {
          const conversation = railConversationEntitiesById.get(id);
          return conversation ? [conversation] : [];
        })
      : [];

    const runtimeRailSections = runtimeRailMemberships
      ? projectConversationRailMemberships({
          conversations: railConversationEntities,
          labels,
          sections: runtimeRailMemberships
        })
      : null;

    const railActiveConversationCandidate =
      resolveConversationRailActiveConversation({
        activeConversation,
        activeConversationId,
        conversations: railConversationEntities
      });
    const stableRailActiveConversation = stabilizeConversationSectionItems(
      railActiveConversationRef.current,
      railActiveConversationCandidate ? [railActiveConversationCandidate] : []
    );
    railActiveConversationRef.current = stableRailActiveConversation;
    const railActiveConversation = stableRailActiveConversation[0] ?? null;
    const runtimeSectionsWithTransientConversations =
      projectConversationRailSectionsWithTransientConversations({
        conversations,
        labels,
        reconcilingSessionIds: runtimeRailReconcilingSessionIds,
        sections: runtimeRailSections ?? []
      });
    const runtimeDisplayProjection =
      projectConversationRailSectionsWithActiveConversation({
        activeConversation: railActiveConversation,
        labels,
        sections: runtimeSectionsWithTransientConversations
      });
    const runtimeDisplaySections = preserveConversationRailSectionTemplates({
      labels,
      sections: runtimeDisplayProjection.sections,
      userProjects
    });
    const railActiveOverlay = runtimeDisplayProjection.activeOverlay;

    const displayConversations = useMemo(() => {
      if (backendSearchActive) {
        return backendSearchConversations;
      }
      const canonicalConversations =
        runtimeSectionsEnabled || runtimeRailSections
          ? runtimeDisplaySections.flatMap((section) => section.items)
          : conversations;
      const activeOverlayConversation = railActiveOverlay?.conversation;
      if (
        !activeOverlayConversation ||
        canonicalConversations.some(
          (conversation) => conversation.id === activeOverlayConversation.id
        )
      ) {
        return canonicalConversations;
      }
      return [...canonicalConversations, activeOverlayConversation];
    }, [
      backendSearchActive,
      backendSearchConversations,
      conversations,
      railActiveOverlay,
      runtimeDisplaySections,
      runtimeRailSections,
      runtimeSectionsEnabled
    ]);

    const filteredConversationResult = useMemo(() => {
      const startedAtMs = agentGuiPerfNowMs();
      const query = conversationQuery.trim().toLowerCase();
      const items = backendSearchActive
        ? displayConversations
        : !query
          ? displayConversations
          : displayConversations.filter((candidate) =>
              conversationPlainTitle(candidate, labels, uiLanguage)
                .toLowerCase()
                .includes(query)
            );
      return {
        items,
        filterMs: roundAgentGuiPerfMs(agentGuiPerfNowMs() - startedAtMs)
      };
    }, [
      backendSearchActive,
      conversationQuery,
      displayConversations,
      labels,
      uiLanguage
    ]);
    const filteredConversations = filteredConversationResult.items;
    const groupedConversationResult = useMemo(() => {
      const startedAtMs = agentGuiPerfNowMs();
      const query = conversationQuery.trim();
      const rawGroups = backendSearchActive
        ? projectConversationRailSearchSections({
            conversations: filteredConversations,
            labels,
            sections: runtimeDisplaySections
          })
        : runtimeSectionsEnabled || runtimeRailSections
          ? runtimeDisplaySections.length > 0
            ? !query
              ? runtimeDisplaySections
              : runtimeDisplaySections
                  .map((section) => ({
                    ...section,
                    items: section.items.filter((item) =>
                      filteredConversations.some(
                        (conversation) => conversation.id === item.id
                      )
                    )
                  }))
                  .filter(
                    (section) =>
                      section.kind === "project" ||
                      section.items.length > 0 ||
                      (section.id === railActiveOverlay?.sectionId &&
                        filteredConversations.some(
                          (conversation) =>
                            conversation.id ===
                            railActiveOverlay.conversation.id
                        ))
                  )
            : []
          : projectConversationRailSectionsByExactKey({
              conversations: filteredConversations,
              labels,
              userProjects,
              includeEmptySections: !query
            });
      const groups = stabilizeConversationSections(
        groupedConversationsRef.current,
        rawGroups
      );
      groupedConversationsRef.current = groups;
      return {
        groups,
        groupMs: roundAgentGuiPerfMs(agentGuiPerfNowMs() - startedAtMs)
      };
    }, [
      conversationQuery,
      backendSearchActive,
      filteredConversations,
      labels,
      railActiveOverlay,
      runtimeDisplaySections,
      runtimeRailSections,
      runtimeSectionsEnabled,
      userProjects
    ]);
    const groupedConversations = groupedConversationResult.groups;
    const hasRailContent = groupedConversations.some(
      (section) =>
        section.items.length > 0 ||
        (section.kind === "project" && section.project !== null)
    );
    const appendProjectRailHeader =
      groupedConversations.length > 0 &&
      !groupedConversations.some(
        (section) =>
          section.kind !== "pinned" &&
          !(
            section.kind === "project" &&
            isConversationRailProjectPinned(section.project)
          )
      );
    const groupedConversationIdentityKey = useMemo(
      () =>
        `${groupedConversations
          .map(
            (section) =>
              `${section.id}:${section.items.map((item) => item.id).join(",")}`
          )
          .join("|")}|active:${railActiveOverlay?.conversation.id ?? ""}`,
      [groupedConversations, railActiveOverlay]
    );
    const sectionAgentTargetId =
      conversationFilter.kind === "agentTarget"
        ? conversationFilter.agentTargetId.trim()
        : "";
    const { requestProjectRemoval, requestSectionBatchDeletion } =
      useAgentGUIConversationRailBatchDeletion({
        batchDeletionAvailable,
        isDeletingProjectConversations,
        isInteractionLocked,
        isRequestingBatchDeletion,
        onConfirmDeleteProjectConversations,
        sectionAgentTargetId,
        setIsRequestingBatchDeletion,
        setPendingProjectAction
      });
    const isRuntimeRailLoading = isConversationRailInitialLoadPending({
      pending: runtimeRailSectionsPending,
      runtimeSectionsEnabled,
      sections: runtimeRailMemberships
    });
    const isConversationRailListLoading = backendSearchActive
      ? railSearch.pending
      : isRuntimeRailLoading ||
        (isLoadingConversations && conversations.length === 0);
    const shouldShowConversationSkeleton = useDelayedBoolean(
      isConversationRailListLoading,
      300
    );
    const shouldShowConversationEmptyState =
      !isConversationRailListLoading && groupedConversations.length === 0;
    const shouldShowConversationSearchError =
      backendSearchActive &&
      railSearch.failed &&
      railSearch.sessionIds.length === 0;
    const activityProjection = activityView.presentationActive
      ? activityView.projection
      : null;
    const activityViewVisible = activityProjection !== null;
    const conversationRailError =
      runtimeSectionsEnabled &&
      railQuery.runtimeRailFailed &&
      runtimeRailScopeResolved &&
      !backendSearchActive &&
      !activityViewVisible;
    const hostToast = agentHostApi?.toast;
    const railViewState = useAgentGUIConversationRailViewState({
      activeConversationId,
      contentReady:
        (backendSearchActive
          ? !railSearch.pending
          : runtimeRailScopeResolved && !isRuntimeRailLoading) &&
        !shouldShowConversationSkeleton,
      groupedConversationIdentityKey,
      revealRequest,
      searchQuery: conversationQuery,
      scopeKey: railViewScopeKey
    });
    const {
      clear: clearProjectDrag,
      dragState: projectDragState,
      drop: dropProject,
      installGlobalListeners: installProjectDragGlobalListeners,
      isMovePending: isProjectMovePending,
      keepValidDropTarget: keepValidProjectDropTarget,
      start: startProjectDrag,
      updateTarget: updateProjectDropTarget
    } = useAgentGUIProjectDrag({
      disabled: projectDragBaseLocked,
      onMoveProject,
      scrollViewportRef: railViewState.conversationListRef,
      userProjects
    });
    const projectDragLocked = projectDragBaseLocked || isProjectMovePending;
    useEffect(() => {
      if (!conversationRailError || !hasRailContent) {
        railFailureToastShownRef.current = false;
      } else if (!railFailureToastShownRef.current) {
        railFailureToastShownRef.current = true;
        showAgentGUIControllerErrorToast(
          hostToast,
          labels.conversationsLoadFailed
        );
      }
      return installProjectDragGlobalListeners();
    }, [
      conversationRailError,
      hasRailContent,
      hostToast,
      installProjectDragGlobalListeners,
      labels.conversationsLoadFailed
    ]);

    return (
      <aside
        ref={railElementRef}
        className={styles.rail}
        aria-hidden={isCollapsed ? "true" : undefined}
      >
        <AgentGUIConversationRailToolbar
          activityView={activityView}
          conversationQuery={conversationQuery}
          createConversationDisabled={createConversationDisabled}
          labels={labels}
          onConversationQueryChange={onConversationQueryChange}
          onCreateConversation={() => onCreateConversation()}
        />
        <ScrollArea
          scrollbarMode="native"
          className="min-h-0 flex-1 [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100"
          viewportRef={railViewState.conversationListRef}
          viewportClassName={styles.conversationList}
          viewportContentStyle={{
            display: "flex",
            flexDirection: "column",
            minHeight: "100%"
          }}
          viewportProps={{
            onDragOver: keepValidProjectDropTarget,
            onDrop: dropProject
          }}
        >
          <AgentGUIConversationRailContentState
            conversationQuery={conversationQuery}
            conversations={conversations}
            hasRailContent={hasRailContent}
            isLoading={shouldShowConversationSkeleton && !activityViewVisible}
            labels={labels}
            onRetry={() => {
              void railQuery.retryRuntimeRail();
            }}
            onRetrySearch={railSearch.retry}
            railError={conversationRailError}
            searchError={shouldShowConversationSearchError}
            showEmptyState={shouldShowConversationEmptyState}
          >
            {activityProjection ? (
              <AgentGUIConversationActivityView
                activeConversationId={activeConversationId}
                conversationsById={activityView.conversationsById}
                isDeletingConversation={isDeletingConversation}
                isRailInteractionLocked={isInteractionLocked}
                labels={labels}
                pendingDeleteConversationId={pendingDeleteConversationId}
                projection={activityProjection}
                registerItemElement={
                  railViewState.registerConversationItemElement
                }
                uiLanguage={uiLanguage}
                workspaceId={workspaceId}
                onCancelDeleteConversation={onCancelDeleteConversation}
                onConfirmDeleteConversation={onConfirmDeleteConversation}
                onMarkConversationUnread={onMarkConversationUnread}
                onOpenConversationWindow={onOpenConversationWindow}
                onRequestDeleteConversation={onRequestDeleteConversation}
                onRequestRenameConversation={onRequestRenameConversation}
                onSelectConversation={onSelectConversation}
                onToggleConversationPinned={onToggleConversationPinned}
              />
            ) : (
              <fieldset className="contents" disabled={railInteractionsLocked}>
                {groupedConversations.map((section, sectionIndex) => {
                  const projectPath =
                    section.kind === "project"
                      ? (section.project?.path ?? "")
                      : "";
                  const projectLabel =
                    section.kind === "project" ? section.label : "";
                  const isProjectSection = section.kind === "project";
                  const {
                    showPinnedHeader: showPinnedProjectHeader,
                    showProjectsHeader: showProjectRailHeader
                  } = conversationRailSectionHeaderVisibility(
                    groupedConversations,
                    sectionIndex
                  );
                  const isSectionCollapsed =
                    isProjectSection &&
                    railViewState.collapsedSectionIds.has(section.id);
                  const sectionPageState = sectionPageStates.get(section.id);
                  const searchSectionHasMore =
                    backendSearchActive &&
                    sectionIndex === groupedConversations.length - 1 &&
                    railSearch.hasMore;
                  const activeOverlayConversation =
                    !backendSearchActive &&
                    railActiveOverlay?.sectionId === section.id &&
                    (!conversationQuery.trim() ||
                      filteredConversations.some(
                        (conversation) =>
                          conversation.id === railActiveOverlay.conversation.id
                      ))
                      ? railActiveOverlay.conversation
                      : null;
                  const activeOverlayIsCanonical = Boolean(
                    activeOverlayConversation &&
                    section.items.some(
                      (item) =>
                        item.projectionSource !== "pending_activation" &&
                        item.id === activeOverlayConversation.id
                    )
                  );
                  const activeOverlayCountsTowardTotal = Boolean(
                    activeOverlayConversation &&
                    activeOverlayConversation.projectionSource !==
                      "pending_activation" &&
                    matchesAgentGUIConversationSummaryFilter(
                      activeOverlayConversation,
                      conversationFilter
                    )
                  );
                  const sectionTotalCount = backendSearchActive
                    ? section.items.length + (searchSectionHasMore ? 1 : 0)
                    : (sectionPageState?.totalCount ??
                      section.items.filter(
                        (item) => item.projectionSource !== "pending_activation"
                      ).length +
                        (activeOverlayCountsTowardTotal &&
                        !activeOverlayIsCanonical
                          ? 1
                          : 0));
                  const sectionHasMore =
                    searchSectionHasMore ||
                    (!conversationQuery.trim() &&
                      sectionPageState?.hasMore === true);
                  const batchDeletionDisabled =
                    !batchDeletionAvailable ||
                    hasConversationQuery ||
                    (section.items.length === 0 && !sectionHasMore) ||
                    isDeletingProjectConversations ||
                    isRequestingBatchDeletion;
                  return (
                    <Fragment key={section.id}>
                      {showPinnedProjectHeader ? (
                        <div className={styles.pinnedProjectRailHeader}>
                          {labels.sectionPinned}
                        </div>
                      ) : null}
                      {showProjectRailHeader ? (
                        <AgentGUIProjectRailHeader
                          disabled={
                            railInteractionsLocked ||
                            isUserProjectMutationPending
                          }
                          labels={labels}
                          selectProjectDirectory={selectProjectDirectory}
                          workspaceUserProjectI18n={workspaceUserProjectI18n}
                        />
                      ) : null}
                      <AgentGUIConversationRailSectionPresentationProvider
                        batchDeletionDisabled={batchDeletionDisabled}
                        projectActionLocked={projectActionLocked}
                        projectDragDisabled={projectDragLocked}
                      >
                        <AgentGUIConversationRailSection
                          activeConversation={activeOverlayConversation}
                          activeConversationCountsTowardTotal={
                            activeOverlayCountsTowardTotal
                          }
                          activeConversationId={conversationRailSectionActiveConversationId(
                            {
                              activeConversation: activeOverlayConversation,
                              activeConversationId,
                              section
                            }
                          )}
                          createConversationDisabled={
                            createConversationDisabled
                          }
                          isDeletingConversation={isDeletingConversation}
                          isLoadingMoreConversations={
                            backendSearchActive
                              ? railSearch.loadingMore
                              : (sectionPageState?.isLoading ?? false)
                          }
                          isRailInteractionLocked={isInteractionLocked}
                          isProjectActionLocked={isProjectActionLocked}
                          projectDragging={
                            projectDragState !== null &&
                            projectDragState.projectId === section.project?.id
                          }
                          projectDropIndicator={
                            projectDragState?.indicatorSectionId === section.id
                              ? projectDragState.indicator
                              : null
                          }
                          isSectionCollapsed={isSectionCollapsed}
                          labels={labels}
                          pendingDeleteConversationId={
                            pendingDeleteConversationId
                          }
                          projectLabel={projectLabel}
                          projectPath={projectPath}
                          registerItemElement={
                            railViewState.registerConversationItemElement
                          }
                          section={section}
                          sectionHasMore={sectionHasMore}
                          sectionTotalCount={sectionTotalCount}
                          visibleItemLimit={railViewState.visibleItemLimitForSection(
                            section.id
                          )}
                          uiLanguage={uiLanguage}
                          workspaceId={workspaceId}
                          onCancelDeleteConversation={
                            onCancelDeleteConversation
                          }
                          onConfirmDeleteConversation={
                            onConfirmDeleteConversation
                          }
                          onCreateConversation={onCreateConversation}
                          onLoadMoreConversations={
                            backendSearchActive
                              ? railSearch.loadMore
                              : loadMoreSectionConversations
                          }
                          onRequestDeleteConversation={
                            onRequestDeleteConversation
                          }
                          onRequestRenameConversation={
                            onRequestRenameConversation
                          }
                          onSelectConversation={onSelectConversation}
                          onRequestSectionBatchDeletion={
                            requestSectionBatchDeletion
                          }
                          onRequestProjectRemoval={requestProjectRemoval}
                          onToggleConversationPinned={
                            onToggleConversationPinned
                          }
                          onToggleProjectPinned={onToggleProjectPinned}
                          onMarkConversationUnread={onMarkConversationUnread}
                          onOpenProjectFiles={onOpenProjectFiles}
                          onOpenConversationWindow={onOpenConversationWindow}
                          onToggleProjectSectionCollapsed={
                            railViewState.toggleProjectSectionCollapsed
                          }
                          onVisibleItemLimitChange={
                            railViewState.setSectionVisibleItemLimit
                          }
                          onProjectDragStart={startProjectDrag}
                          onProjectDragEnd={clearProjectDrag}
                          onProjectDragOver={updateProjectDropTarget}
                          onProjectMenuOpenChange={onProjectMenuOpenChange}
                        />
                      </AgentGUIConversationRailSectionPresentationProvider>
                    </Fragment>
                  );
                })}
                {appendProjectRailHeader ? (
                  <AgentGUIProjectRailHeader
                    disabled={
                      railInteractionsLocked || isUserProjectMutationPending
                    }
                    labels={labels}
                    selectProjectDirectory={selectProjectDirectory}
                    workspaceUserProjectI18n={workspaceUserProjectI18n}
                  />
                ) : null}
              </fieldset>
            )}
          </AgentGUIConversationRailContentState>
        </ScrollArea>
        {footer ? <div className="shrink-0 pb-2">{footer}</div> : null}
        <AgentGUIProjectActionConfirmationDialog
          action={pendingProjectAction}
          isDeletingProjectConversations={isDeletingProjectConversations}
          isInteractionLocked={isInteractionLocked}
          labels={labels}
          onConfirmDeleteConversations={onConfirmDeleteConversations}
          onRemoveProject={onRemoveProject}
          setAction={setPendingProjectAction}
        />
      </aside>
    );
  }
);
