import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Button as SystemButton,
  ConfirmationDialog
} from "@tutti-os/ui-system";
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
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import {
  isConversationRailInitialLoadPending,
  projectConversationRailMemberships,
  projectConversationRailSectionsByExactKey,
  projectConversationRailSearchSections,
  projectConversationRailSectionsWithActiveConversation,
  projectConversationRailSectionsWithTransientConversations,
  resolveConversationRailActiveConversation,
  stabilizeConversationSectionItems,
  stabilizeConversationSections
} from "../model/agentGuiConversationRail";
import { preserveConversationRailSectionTemplates } from "../model/agentGuiConversationRailSectionTemplates";
import type { useAgentGUIConversationRailQuery } from "../controller/useAgentGUIConversationRailQuery";
import { AgentGUIConversationRailSection } from "./AgentGUIConversationRailSection";
import { AgentGUIProjectRailHeader } from "./AgentGUIConversationRailItem";
import {
  agentGuiPerfNowMs,
  conversationPlainTitle,
  roundAgentGuiPerfMs
} from "./agentGUIViewUtils";
import styles from "../AgentGUINode.styles";

const AGENT_GUI_CONFIRMATION_DIALOG_CLASS_NAME =
  "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]";
const AGENT_GUI_CONFIRMATION_DIALOG_OVERLAY_CLASS_NAME =
  "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]";

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
  footer?: React.ReactNode;
  workspaceId: string;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
  activeConversationId: string | null;
  pendingDeleteConversationId: string | null;
  isLoadingConversations: boolean;
  isDeletingConversation: boolean;
  isDeletingProjectConversations: boolean;
  labels: AgentGUIViewLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  uiLanguage: UiLanguage;
  previewMode: boolean;
  createConversationDisabled: boolean;
  isCollapsed: boolean;
  agentTargets: AgentGUINodeViewModel["rail"]["agentTargets"];
  agentTargetsLoading: AgentGUINodeViewModel["rail"]["agentTargetsLoading"];
  conversationFilter: AgentGUINodeViewModel["rail"]["conversationFilter"];
  sectionAgentTargetFallbackId: string | null;
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
    pendingDeleteConversationId,
    isLoadingConversations,
    isDeletingConversation,
    isDeletingProjectConversations,
    labels,
    workspaceUserProjectI18n,
    uiLanguage,
    previewMode,
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
    onConfirmDeleteProjectConversations,
    onConfirmDeleteConversations,
    onRequestDeleteConversation,
    onRequestRenameConversation,
    onCancelDeleteConversation,
    onConfirmDeleteConversation,
    onConversationQueryChange
  }: AgentGUIConversationRailPaneProps): React.JSX.Element {
    "use memo";
    const [collapsedProjectSectionIds, setCollapsedProjectSectionIds] =
      useState<ReadonlySet<string>>(() => new Set());
    const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
    const [pendingProjectAction, setPendingProjectAction] =
      useState<AgentGUIProjectActionDialog | null>(null);
    const [isRequestingBatchDeletion, setIsRequestingBatchDeletion] =
      useState(false);
    const { railSearch } = railQuery;
    const railElementRef = useRef<HTMLElement | null>(null);
    const conversationListRef = useRef<HTMLDivElement | null>(null);
    const conversationItemElementsRef = useRef(
      new Map<string, HTMLDivElement>()
    );
    const activeConversationScrollCompletedRef = useRef<string | null>(null);
    const previousActiveConversationIdRef = useRef<string | null>(null);
    const railActiveConversationRef = useRef<
      AgentGUINodeViewModel["rail"]["conversations"]
    >([]);
    const groupedConversationsRef = useRef<ConversationSection[] | null>(null);
    const {
      loadMoreSectionConversations,
      isInteractionLocked,
      runtimeSectionsEnabled,
      runtimeRailConversations,
      runtimeRailMemberships,
      runtimeRailReconcilingSessionIds,
      runtimeRailSectionsPending,
      sectionPageStates
    } = railQuery;

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

    useEffect(() => {
      // timing: refresh relative timestamps in the rail once a minute
      const timer = window.setInterval(() => {
        setCurrentTimeMs(Date.now());
      }, 60_000);
      return () => {
        window.clearInterval(timer);
      };
    }, []);

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
    const sectionPaginationScopeKey = `${
      conversationFilter.kind === "agentTarget"
        ? `${workspaceId}:agentTarget:${conversationFilter.agentTargetId.trim()}`
        : `${workspaceId}:all:${sectionAgentTargetFallbackId?.trim() ?? ""}`
    }:search:${conversationQuery.trim()}`;
    const toggleProjectSectionCollapsed = useCallback((sectionId: string) => {
      setCollapsedProjectSectionIds((current) => {
        const next = new Set(current);
        if (next.has(sectionId)) {
          next.delete(sectionId);
        } else {
          next.add(sectionId);
        }
        return next;
      });
    }, []);
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
    const requestSectionBatchDeletion = useCallback(
      (section: ConversationSection) => {
        if (
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
      },
      [
        isDeletingProjectConversations,
        isRequestingBatchDeletion,
        isInteractionLocked,
        onConfirmDeleteProjectConversations,
        sectionAgentTargetId
      ]
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
    const registerConversationItemElement = useCallback(
      (itemId: string, element: HTMLDivElement | null) => {
        if (element) {
          conversationItemElementsRef.current.set(itemId, element);
        } else {
          conversationItemElementsRef.current.delete(itemId);
        }
      },
      []
    );

    useLayoutEffect(() => {
      const activeId = activeConversationId?.trim() ?? "";
      if (!activeId) {
        previousActiveConversationIdRef.current = null;
        activeConversationScrollCompletedRef.current = null;
        return;
      }
      if (previousActiveConversationIdRef.current !== activeId) {
        previousActiveConversationIdRef.current = activeId;
        activeConversationScrollCompletedRef.current = null;
      }
      if (activeConversationScrollCompletedRef.current === activeId) {
        return;
      }
      const activeElement = conversationItemElementsRef.current.get(activeId);
      if (!activeElement) {
        return;
      }
      activeElement.scrollIntoView({ block: "nearest" });
      activeConversationScrollCompletedRef.current = activeId;
    }, [activeConversationId, groupedConversationIdentityKey]);

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
          viewportRef={conversationListRef}
          viewportClassName={styles.conversationList}
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
                const showProjectRailHeader =
                  !conversationQuery.trim() &&
                  section.kind !== "pinned" &&
                  (sectionIndex === 0 ||
                    groupedConversations[sectionIndex - 1]?.kind === "pinned");
                const isSectionCollapsed =
                  isProjectSection &&
                  collapsedProjectSectionIds.has(section.id);
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
                return (
                  <Fragment key={section.id}>
                    {showProjectRailHeader ? (
                      <AgentGUIProjectRailHeader
                        disabled={railInteractionsLocked}
                        labels={labels}
                        selectProjectDirectory={selectProjectDirectory}
                        workspaceUserProjectI18n={workspaceUserProjectI18n}
                      />
                    ) : null}
                    <AgentGUIConversationRailSection
                      activeConversation={activeOverlayConversation}
                      activeConversationCountsTowardTotal={
                        activeOverlayCountsTowardTotal
                      }
                      activeConversationId={activeConversationId}
                      createConversationDisabled={createConversationDisabled}
                      currentTimeMs={currentTimeMs}
                      isDeletingConversation={isDeletingConversation}
                      isDeletingProjectConversations={
                        isDeletingProjectConversations
                      }
                      isRequestingBatchDeletion={isRequestingBatchDeletion}
                      isConversationSearchActive={Boolean(
                        conversationQuery.trim()
                      )}
                      isLoadingMoreConversations={
                        backendSearchActive
                          ? railSearch.loadingMore
                          : (sectionPageState?.isLoading ?? false)
                      }
                      isRailInteractionLocked={isInteractionLocked}
                      isSectionCollapsed={isSectionCollapsed}
                      labels={labels}
                      pendingDeleteConversationId={pendingDeleteConversationId}
                      paginationScopeKey={sectionPaginationScopeKey}
                      previewMode={previewMode}
                      projectLabel={projectLabel}
                      projectPath={projectPath}
                      registerItemElement={registerConversationItemElement}
                      section={section}
                      sectionHasMore={sectionHasMore}
                      sectionTotalCount={sectionTotalCount}
                      uiLanguage={uiLanguage}
                      workspaceId={workspaceId}
                      onCancelDeleteConversation={onCancelDeleteConversation}
                      onConfirmDeleteConversation={onConfirmDeleteConversation}
                      onCreateConversation={onCreateConversation}
                      onLoadMoreConversations={
                        backendSearchActive
                          ? railSearch.loadMore
                          : loadMoreSectionConversations
                      }
                      onRequestDeleteConversation={onRequestDeleteConversation}
                      onRequestRenameConversation={onRequestRenameConversation}
                      onSelectConversation={onSelectConversation}
                      onRequestSectionBatchDeletion={
                        requestSectionBatchDeletion
                      }
                      setPendingProjectAction={setPendingProjectAction}
                      onToggleConversationPinned={onToggleConversationPinned}
                      onMarkConversationUnread={onMarkConversationUnread}
                      onOpenProjectFiles={onOpenProjectFiles}
                      onOpenConversationWindow={onOpenConversationWindow}
                      onToggleProjectSectionCollapsed={
                        toggleProjectSectionCollapsed
                      }
                    />
                  </Fragment>
                );
              })}
            </fieldset>
          )}
        </ScrollArea>
        {footer ? <div className="shrink-0 pb-2">{footer}</div> : null}
        <ConfirmationDialog
          cancelLabel={labels.cancel}
          className={AGENT_GUI_CONFIRMATION_DIALOG_CLASS_NAME}
          confirmBusy={
            (pendingProjectAction?.kind === "batch-delete" ||
              pendingProjectAction?.kind === "batch-delete-conversations") &&
            isDeletingProjectConversations
          }
          confirmDisabled={railInteractionsLocked}
          confirmLabel={
            pendingProjectAction?.kind === "batch-delete"
              ? labels.batchDeleteProjectSessionsConfirm
              : pendingProjectAction?.kind === "batch-delete-conversations"
                ? labels.batchDeleteConversationsConfirm
                : labels.removeProject
          }
          description={
            pendingProjectAction?.kind === "batch-delete"
              ? labels.batchDeleteProjectSessionsBody(
                  pendingProjectAction.conversationCount,
                  pendingProjectAction.label
                )
              : pendingProjectAction?.kind === "batch-delete-conversations"
                ? labels.batchDeleteConversationsBody(
                    pendingProjectAction.conversationCount
                  )
                : pendingProjectAction
                  ? labels.removeProjectConfirmDescription(
                      pendingProjectAction.label
                    )
                  : undefined
          }
          onCancel={() => setPendingProjectAction(null)}
          onConfirm={() => {
            if (isInteractionLocked()) return;
            const action = pendingProjectAction;
            setPendingProjectAction(null);
            if (!action) {
              return;
            }
            if (action.kind === "batch-delete") {
              onConfirmDeleteConversations(action.sessionIds);
              return;
            }
            if (action.kind === "batch-delete-conversations") {
              onConfirmDeleteConversations(action.sessionIds);
              return;
            }
            onRemoveProject(action.path);
          }}
          onOpenChange={(open) => {
            if (!open) {
              setPendingProjectAction(null);
            }
          }}
          open={pendingProjectAction !== null}
          overlayClassName={AGENT_GUI_CONFIRMATION_DIALOG_OVERLAY_CLASS_NAME}
          title={
            pendingProjectAction?.kind === "batch-delete"
              ? labels.batchDeleteProjectSessionsTitle
              : pendingProjectAction?.kind === "batch-delete-conversations"
                ? labels.batchDeleteConversationsTitle
                : labels.removeProjectConfirmTitle
          }
          tone="destructive"
        />
      </aside>
    );
  }
);
