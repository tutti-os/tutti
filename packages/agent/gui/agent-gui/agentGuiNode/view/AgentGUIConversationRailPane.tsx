import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { Button as SystemButton } from "@tutti-os/ui-system";
import { ScrollArea } from "@tutti-os/ui-system/components";
import { CreateChatIcon } from "@tutti-os/ui-system/icons";
import { Button } from "../../../app/renderer/components/ui/button";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { TaskSearchField } from "../../RoomIssueNode/TaskSearchField";
import { AgentConversationListSkeleton } from "../AgentConversationListSkeleton";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import { matchesAgentGUIConversationSummaryFilter } from "../model/agentGuiConversationFilter";
import type { AgentGUINodeViewProps } from "../AgentGUINodeView";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
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
import { AgentGUIConversationRailSectionPresentationProvider } from "./agentGUIConversationRailSectionPresentationContext";
import { AgentGUIProjectActionConfirmationDialog } from "./AgentGUIProjectActionConfirmationDialog";
import { AgentGUIProjectRailHeader } from "./AgentGUIConversationRailItem";
import {
  agentGuiPerfNowMs,
  conversationPlainTitle,
  roundAgentGuiPerfMs,
  useStableEventCallback
} from "./agentGUIViewUtils";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import styles from "../AgentGUINode.styles";
import { useAgentGUIConversationRailViewState } from "./useAgentGUIConversationRailViewState";
import { useAgentGUIProjectMenuState } from "./useAgentGUIProjectMenuState";

function useDelayedBoolean(value: boolean, delayMs: number): boolean {
  const [delayedValue, setDelayedValue] = useState(false);
  useEffect(() => {
    if (!value) {
      setDelayedValue(false);
      return;
    }
    // timing: caller-provided debounce before reflecting the value as true
    const timer = window.setTimeout(() => setDelayedValue(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return delayedValue;
}

export interface AgentGUIConversationRailControllerProps {
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
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
  sectionAgentTargetFallbackId: string | null;
  /**
   * Lets the host subtree observe the rail query controller's interaction
   * lock (e.g. so header-dispatched session actions honor the same lock).
   */
  registerInteractionLockProbe?: (probe: (() => boolean) | null) => void;
  onUpdateConversationFilter: (
    filter: AgentGUINodeViewModel["rail"]["conversationFilter"]
  ) => void;
  onSelectConversationFilterTarget: AgentGUINodeViewProps["actions"]["selectConversationFilterTarget"];
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
  onRemoveProject: (path: string) => void;
  onMoveProject: (
    projectId: string,
    beforeProjectId: string | null
  ) => Promise<void>;
  onToggleProjectPinned: (projectId: string, pinned: boolean) => Promise<void>;
  onConfirmDeleteProjectConversations: (
    sectionKey?: string,
    agentTargetId?: string | null
  ) => Promise<string[]>;
  onConfirmDeleteConversations: (agentSessionIds: string[]) => void;
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

export type AgentGUIProjectActionDialog =
  | {
      kind: "batch-delete";
      conversationCount: number;
      label: string;
      sessionIds: string[];
    }
  | {
      kind: "batch-delete-conversations";
      conversationCount: number;
      label: string;
      sessionIds: string[];
    }
  | {
      kind: "remove";
      label: string;
      path: string;
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
    sectionAgentTargetFallbackId,
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
    const [pendingProjectAction, setPendingProjectAction] =
      useState<AgentGUIProjectActionDialog | null>(null);
    const [isRequestingBatchDeletion, setIsRequestingBatchDeletion] =
      useState(false);
    const { railSearch } = railQuery;
    const railElementRef = useRef<HTMLElement | null>(null);
    const railActiveConversationRef = useRef<
      AgentGUINodeViewModel["rail"]["conversations"]
    >([]);
    const groupedConversationsRef = useRef<ConversationSection[] | null>(null);
    const {
      batchDeletionAvailable,
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
    const railViewScopeKey = agentGUIConversationRailViewScopeKey({
      conversationFilter,
      sectionAgentTargetFallbackId,
      workspaceId
    });
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
        : (sectionAgentTargetFallbackId?.trim() ?? "");
    const requestSectionBatchDeletion = useStableEventCallback(
      (section: ConversationSection) => {
        if (
          !batchDeletionAvailable ||
          isInteractionLocked() ||
          isDeletingProjectConversations ||
          isRequestingBatchDeletion
        ) {
          return;
        }
        setIsRequestingBatchDeletion(true);
        void onConfirmDeleteProjectConversations(
          section.id,
          sectionAgentTargetId || undefined
        )
          .then((sessionIds) => {
            if (isInteractionLocked() || sessionIds.length === 0) {
              return;
            }
            setPendingProjectAction({
              kind:
                section.kind === "project"
                  ? "batch-delete"
                  : "batch-delete-conversations",
              conversationCount: sessionIds.length,
              label: section.label,
              sessionIds: [...sessionIds]
            });
          })
          .finally(() => setIsRequestingBatchDeletion(false));
      }
    );
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
      return installProjectDragGlobalListeners();
    }, [installProjectDragGlobalListeners]);

    return (
      <aside
        ref={railElementRef}
        className={styles.rail}
        aria-hidden={isCollapsed ? "true" : undefined}
      >
        <div className={styles.railToolbar}>
          <TaskSearchField
            value={conversationQuery}
            placeholder={labels.searchPlaceholder}
            onChange={onConversationQueryChange}
          />
          <Button
            type="button"
            variant="secondary"
            size="dialog"
            className={styles.newConversationIconButton}
            title={labels.newConversation}
            disabled={createConversationDisabled}
            onClick={() => onCreateConversation()}
          >
            <CreateChatIcon aria-hidden="true" />
            <span>{labels.newConversation}</span>
          </Button>
        </div>
        <ScrollArea
          scrollbarMode="native"
          className="min-h-0 flex-1 [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100"
          viewportRef={railViewState.conversationListRef}
          viewportClassName={styles.conversationList}
          viewportProps={{
            onDragOver: keepValidProjectDropTarget,
            onDrop: dropProject
          }}
        >
          {shouldShowConversationSkeleton ? (
            <AgentConversationListSkeleton
              label={labels.loadingConversations}
            />
          ) : shouldShowConversationSearchError ? (
            <div className={styles.emptyState}>
              <span>{labels.searchFailed}</span>
              <SystemButton
                type="button"
                variant="outline"
                size="sm"
                onClick={railSearch.retry}
              >
                {labels.retrySearch}
              </SystemButton>
            </div>
          ) : shouldShowConversationEmptyState ? (
            <div className={styles.emptyState}>
              <span>
                {conversationQuery.trim()
                  ? labels.searchNoConversations
                  : conversations.length === 0
                    ? labels.noConversations
                    : labels.conversationUnavailable}
              </span>
            </div>
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
                          railInteractionsLocked || isUserProjectMutationPending
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
                        createConversationDisabled={createConversationDisabled}
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
                        onCancelDeleteConversation={onCancelDeleteConversation}
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
                        setPendingProjectAction={setPendingProjectAction}
                        onToggleConversationPinned={onToggleConversationPinned}
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
