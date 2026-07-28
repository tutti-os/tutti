import { memo, useCallback } from "react";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import type { AgentGUIProjectActionDialog } from "./AgentGUIConversationRailPane";
import { AgentGUIConversationRailItem } from "./AgentGUIConversationRailItem";
import { AgentGUIConversationRailSectionHeader } from "./AgentGUIConversationRailSectionHeader";
import { insertConversationRailSectionOverlay } from "../model/agentGuiConversationRail";
import { AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE } from "../model/agentGuiConversationRailViewState";
import {
  useOptionalStableEventCallback,
  useStableEventCallback
} from "./agentGUIViewUtils";
import styles from "../AgentGUINode.styles";

interface AgentGUIConversationRailSectionProps {
  section: ConversationSection;
  activeConversation: ConversationSection["items"][number] | null;
  activeConversationCountsTowardTotal: boolean;
  projectPath: string;
  projectLabel: string;
  isSectionCollapsed: boolean;
  activeConversationId: string | null;
  pendingDeleteConversationId: string | null;
  isDeletingConversation: boolean;
  isLoadingMoreConversations: boolean;
  isRailInteractionLocked: () => boolean;
  isProjectActionLocked: () => boolean;
  projectDragging: boolean;
  projectDropIndicator: "before" | "after" | null;
  sectionHasMore: boolean;
  sectionTotalCount: number;
  visibleItemLimit: number;
  createConversationDisabled: boolean;
  labels: AgentGUIConversationRailLabels;
  uiLanguage: UiLanguage;
  workspaceId: string;
  registerItemElement: (itemId: string, element: HTMLDivElement | null) => void;
  onCreateConversation: (options?: {
    projectPath?: string | null;
    source?: string;
  }) => void;
  onToggleProjectSectionCollapsed: (sectionId: string) => void;
  onVisibleItemLimitChange: (sectionId: string, limit: number) => void;
  onRequestSectionBatchDeletion: (section: ConversationSection) => void;
  setPendingProjectAction: (action: AgentGUIProjectActionDialog | null) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onLoadMoreConversations: (section: ConversationSection) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onToggleProjectPinned: (projectId: string, pinned: boolean) => Promise<void>;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenProjectFiles?: ((action: WorkspaceLinkAction) => void) | null;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (
    conversation: ConversationSection["items"][number]
  ) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
  onProjectDragStart: (
    section: ConversationSection,
    event: React.DragEvent<HTMLElement>
  ) => void;
  onProjectDragEnd: () => void;
  onProjectDragOver: (
    section: ConversationSection,
    edge: "before" | "after",
    event: React.DragEvent<HTMLElement>
  ) => void;
  onProjectMenuOpenChange: (sectionId: string, open: boolean) => void;
}

export const AgentGUIConversationRailSection = memo(
  function AgentGUIConversationRailSection({
    section,
    activeConversation,
    activeConversationCountsTowardTotal,
    projectPath,
    projectLabel,
    isSectionCollapsed,
    activeConversationId,
    pendingDeleteConversationId,
    isDeletingConversation,
    isLoadingMoreConversations,
    isRailInteractionLocked,
    isProjectActionLocked,
    projectDragging,
    projectDropIndicator,
    sectionHasMore,
    sectionTotalCount,
    visibleItemLimit,
    createConversationDisabled,
    labels,
    uiLanguage,
    workspaceId,
    registerItemElement,
    onCreateConversation,
    onToggleProjectSectionCollapsed,
    onVisibleItemLimitChange,
    onSelectConversation,
    onLoadMoreConversations,
    onRequestSectionBatchDeletion,
    setPendingProjectAction,
    onToggleConversationPinned,
    onToggleProjectPinned,
    onMarkConversationUnread,
    onOpenProjectFiles,
    onOpenConversationWindow,
    onRequestDeleteConversation,
    onRequestRenameConversation,
    onCancelDeleteConversation,
    onConfirmDeleteConversation,
    onProjectDragStart,
    onProjectDragEnd,
    onProjectDragOver,
    onProjectMenuOpenChange
  }: AgentGUIConversationRailSectionProps): React.JSX.Element {
    "use memo";
    const projectPinned = (section.project?.pinnedAtUnixMs ?? 0) > 0;
    const projectId = section.project?.id?.trim() ?? "";
    const hasProjectPath = Boolean(projectPath);
    const pageableItems = section.items.filter(
      (item) => item.projectionSource !== "pending_activation"
    );
    const visibleItemCount = isSectionCollapsed
      ? 0
      : Math.min(visibleItemLimit, pageableItems.length);
    const baseItems = isSectionCollapsed
      ? []
      : section.items
          .filter((item) => item.projectionSource !== "pending_activation")
          .slice(0, visibleItemCount);
    let visibleItems = isSectionCollapsed
      ? []
      : [
          ...section.items.filter(
            (item) => item.projectionSource === "pending_activation"
          ),
          ...baseItems
        ];
    const activeId = activeConversation?.id.trim() ?? "";
    if (
      activeConversation &&
      activeId &&
      activeId === (activeConversationId?.trim() ?? "") &&
      !visibleItems.some((item) => item.id === activeId)
    ) {
      visibleItems = insertConversationRailSectionOverlay(
        section.kind,
        visibleItems,
        activeConversation
      );
    }
    const visiblePageableIds = new Set(
      pageableItems.slice(0, visibleItemCount).map((item) => item.id)
    );
    const visibleCountTowardTotal =
      visiblePageableIds.size +
      (activeConversationCountsTowardTotal &&
      activeConversation &&
      visibleItems.some((item) => item.id === activeConversation.id) &&
      !visiblePageableIds.has(activeConversation.id)
        ? 1
        : 0);
    const canShowMore =
      !isSectionCollapsed &&
      visibleCountTowardTotal < sectionTotalCount &&
      (visibleItemCount < pageableItems.length || sectionHasMore);
    const canShowLess =
      !isSectionCollapsed &&
      visibleItemCount > AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE;
    const showMoreConversations = useCallback(() => {
      if (isRailInteractionLocked()) return;
      if (visibleItemCount >= pageableItems.length && sectionHasMore) {
        onLoadMoreConversations(section);
        onVisibleItemLimitChange(
          section.id,
          visibleItemLimit + AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
        );
        return;
      }
      onVisibleItemLimitChange(
        section.id,
        Math.min(
          pageableItems.length,
          visibleItemLimit + AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
        )
      );
    }, [
      onLoadMoreConversations,
      onVisibleItemLimitChange,
      isRailInteractionLocked,
      pageableItems.length,
      section,
      sectionHasMore,
      visibleItemCount,
      visibleItemLimit
    ]);
    const showLessConversations = useCallback(() => {
      if (isRailInteractionLocked()) return;
      onVisibleItemLimitChange(
        section.id,
        AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
      );
    }, [isRailInteractionLocked, onVisibleItemLimitChange, section.id]);

    const canCreateConversationFromSection =
      section.kind === "conversations" || Boolean(projectPath);
    const createConversationLabel = projectPath
      ? labels.projectSectionEdit
      : labels.newConversation;
    const handleCreateConversation = useStableEventCallback(() => {
      if (isRailInteractionLocked()) return;
      if (projectPath) {
        onCreateConversation({ projectPath, source: "project_section" });
        return;
      }
      onCreateConversation({
        projectPath: null,
        source: "unscoped_section"
      });
    });
    const handleToggleCollapsed = useStableEventCallback(() => {
      if (!isRailInteractionLocked()) {
        onToggleProjectSectionCollapsed(section.id);
      }
    });
    const handleProjectDragStart = useStableEventCallback(
      (event: React.DragEvent<HTMLElement>) =>
        onProjectDragStart(section, event)
    );
    const handleProjectDragEnd = useStableEventCallback(() =>
      onProjectDragEnd()
    );
    const handleProjectDragOver = useStableEventCallback(
      (event: React.DragEvent<HTMLElement>) => {
        const header = event.currentTarget.firstElementChild;
        const rect = (
          header instanceof HTMLElement ? header : event.currentTarget
        ).getBoundingClientRect();
        onProjectDragOver(
          section,
          event.clientY < rect.top + rect.height / 2 ? "before" : "after",
          event
        );
      }
    );
    const handleProjectMenuOpenChange = useStableEventCallback(
      (open: boolean) => onProjectMenuOpenChange(section.id, open)
    );
    const handleOpenProjectFiles = useOptionalStableEventCallback(
      onOpenProjectFiles
        ? () => {
            if (isRailInteractionLocked()) return;
            onOpenProjectFiles({
              directoryPath: projectPath,
              mode: "open",
              path: projectPath,
              source: "agent-project-menu",
              type: "open-workspace-file",
              workspaceRoot: projectPath
            });
          }
        : null
    );
    const handleToggleProjectPinned = useStableEventCallback(() => {
      if (!projectId || isProjectActionLocked()) return;
      void onToggleProjectPinned(projectId, !projectPinned);
    });
    const handleRequestBatchDeletion = useStableEventCallback(() => {
      if (!isRailInteractionLocked()) {
        onRequestSectionBatchDeletion(section);
      }
    });
    const handleRemoveProject = useStableEventCallback(() => {
      if (isProjectActionLocked()) return;
      setPendingProjectAction({
        kind: "remove",
        label: projectLabel || projectPath,
        path: projectPath
      });
    });
    return (
      <section
        className={styles.conversationSection}
        data-collapsed={isSectionCollapsed}
        data-kind={section.kind}
        data-project-dragging={projectDragging ? "true" : undefined}
        data-project-drop-indicator={projectDropIndicator ?? undefined}
        onDragOver={
          section.kind === "project" ? handleProjectDragOver : undefined
        }
      >
        <AgentGUIConversationRailSectionHeader
          canCreateConversation={canCreateConversationFromSection}
          createConversationDisabled={createConversationDisabled}
          createConversationLabel={createConversationLabel}
          hasProjectId={Boolean(projectId)}
          hasProjectPath={hasProjectPath}
          isSectionCollapsed={isSectionCollapsed}
          kind={section.kind}
          labels={labels}
          onCreateConversation={handleCreateConversation}
          onOpenProjectFiles={handleOpenProjectFiles}
          onProjectDragEnd={handleProjectDragEnd}
          onProjectDragStart={handleProjectDragStart}
          onProjectMenuOpenChange={handleProjectMenuOpenChange}
          onRemoveProject={handleRemoveProject}
          onRequestBatchDeletion={handleRequestBatchDeletion}
          onToggleCollapsed={handleToggleCollapsed}
          onToggleProjectPinned={handleToggleProjectPinned}
          projectPinned={projectPinned}
          sectionLabel={section.label}
        />
        <div
          className={styles.conversationSectionItems}
          aria-hidden={isSectionCollapsed ? "true" : undefined}
        >
          <div className={styles.conversationSectionItemsInner}>
            {!isSectionCollapsed && visibleItems.length === 0 ? (
              <div className={styles.conversationSectionEmpty}>
                {labels.emptyProjectConversations}
              </div>
            ) : null}
            {visibleItems.map((item) => (
              <AgentGUIConversationRailItem
                key={item.id}
                active={item.id === activeConversationId}
                isDeletingConversation={isDeletingConversation}
                isPendingDeleteConversation={
                  pendingDeleteConversationId === item.id
                }
                isRailInteractionLocked={isRailInteractionLocked}
                item={item}
                labels={labels}
                registerItemElement={registerItemElement}
                uiLanguage={uiLanguage}
                workspaceId={workspaceId}
                onCancelDeleteConversation={onCancelDeleteConversation}
                onConfirmDeleteConversation={onConfirmDeleteConversation}
                onRequestDeleteConversation={onRequestDeleteConversation}
                onRequestRenameConversation={onRequestRenameConversation}
                onSelectConversation={onSelectConversation}
                onToggleConversationPinned={onToggleConversationPinned}
                onMarkConversationUnread={onMarkConversationUnread}
                onOpenConversationWindow={onOpenConversationWindow}
              />
            ))}
            {canShowMore || canShowLess ? (
              <div className={styles.conversationSectionPagination}>
                {canShowMore ? (
                  <button
                    type="button"
                    className={styles.conversationSectionPaginationButton}
                    disabled={isLoadingMoreConversations}
                    onClick={showMoreConversations}
                  >
                    {labels.showMoreConversations}
                  </button>
                ) : null}
                {canShowLess ? (
                  <button
                    type="button"
                    className={styles.conversationSectionPaginationButton}
                    onClick={showLessConversations}
                  >
                    {labels.showLessConversations}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>
    );
  }
);
