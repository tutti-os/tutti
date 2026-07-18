import { memo, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { BareIconButton } from "@tutti-os/ui-system/components";
import {
  CreateChatIcon,
  FolderIcon,
  FolderOpenLinedIcon,
  MoreHorizontalIcon
} from "@tutti-os/ui-system/icons";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import type { AgentGUIProjectActionDialog } from "./AgentGUIConversationRailPane";
import { AgentGUIConversationRailItem } from "./AgentGUIConversationRailItem";
import { insertConversationRailSectionOverlay } from "../model/agentGuiConversationRail";
import { AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE } from "../model/agentGuiConversationRailViewState";
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
  previewMode: boolean;
  isDeletingConversation: boolean;
  isDeletingProjectConversations: boolean;
  isRequestingBatchDeletion: boolean;
  isConversationSearchActive: boolean;
  isLoadingMoreConversations: boolean;
  isRailInteractionLocked: () => boolean;
  isProjectActionLocked: () => boolean;
  projectDragDisabled: boolean;
  projectDragging: boolean;
  projectDropIndicator: "before" | "after" | null;
  sectionHasMore: boolean;
  sectionTotalCount: number;
  visibleItemLimit: number;
  createConversationDisabled: boolean;
  currentTimeMs: number;
  labels: AgentGUIViewLabels;
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
  onProjectDrop: (event: React.DragEvent<HTMLElement>) => void;
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
    previewMode,
    isDeletingConversation,
    isDeletingProjectConversations,
    isRequestingBatchDeletion,
    isConversationSearchActive,
    isLoadingMoreConversations,
    isRailInteractionLocked,
    isProjectActionLocked,
    projectDragDisabled,
    projectDragging,
    projectDropIndicator,
    sectionHasMore,
    sectionTotalCount,
    visibleItemLimit,
    createConversationDisabled,
    currentTimeMs,
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
    onProjectDrop,
    onProjectMenuOpenChange
  }: AgentGUIConversationRailSectionProps): React.JSX.Element {
    "use memo";
    const isProjectSection = section.kind === "project";
    const projectPinned = (section.project?.pinnedAtUnixMs ?? 0) > 0;
    const projectId = section.project?.id?.trim() ?? "";
    const handleProjectMenuOpenChange = useCallback(
      (open: boolean) => onProjectMenuOpenChange(section.id, open),
      [onProjectMenuOpenChange, section.id]
    );
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
    const handleCreateConversation = useCallback(() => {
      if (isRailInteractionLocked()) return;
      if (projectPath) {
        onCreateConversation({ projectPath, source: "project_section" });
        return;
      }
      onCreateConversation({
        projectPath: null,
        source: "unscoped_section"
      });
    }, [isRailInteractionLocked, onCreateConversation, projectPath]);

    return (
      <section
        className={styles.conversationSection}
        data-collapsed={isSectionCollapsed}
        data-kind={section.kind}
        data-project-dragging={projectDragging ? "true" : undefined}
        data-project-drop-indicator={projectDropIndicator ?? undefined}
      >
        <div
          className={styles.conversationSectionHeader}
          draggable={isProjectSection && !projectDragDisabled}
          onDragStart={(event) => onProjectDragStart(section, event)}
          onDragEnd={onProjectDragEnd}
          onDragOver={(event) => {
            if (!isProjectSection) return;
            const rect = event.currentTarget.getBoundingClientRect();
            onProjectDragOver(
              section,
              event.clientY < rect.top + rect.height / 2 ? "before" : "after",
              event
            );
          }}
          onDrop={isProjectSection ? onProjectDrop : undefined}
        >
          {isProjectSection ? (
            <button
              type="button"
              className={styles.conversationSectionToggle}
              aria-expanded={!isSectionCollapsed}
              aria-label={
                projectPinned
                  ? labels.pinnedProjectAccessibleName(section.label)
                  : section.label
              }
              onClick={() => {
                if (!isRailInteractionLocked()) {
                  onToggleProjectSectionCollapsed(section.id);
                }
              }}
            >
              <ChevronRight
                aria-hidden="true"
                className={styles.conversationSectionChevron}
              />
              <span className={styles.conversationSectionLabel}>
                {isSectionCollapsed ? (
                  <FolderIcon
                    aria-hidden="true"
                    className={styles.conversationSectionLabelIcon}
                    data-project-drag-icon="true"
                  />
                ) : (
                  <FolderOpenLinedIcon
                    aria-hidden="true"
                    className={styles.conversationSectionLabelIcon}
                    data-project-drag-icon="true"
                  />
                )}
                <span>{section.label}</span>
              </span>
            </button>
          ) : (
            <div className={styles.conversationSectionToggle}>
              <span className={styles.conversationSectionLabel}>
                <span>{section.label}</span>
              </span>
            </div>
          )}
          {canCreateConversationFromSection ? (
            <div
              className={styles.conversationSectionActions}
              data-project-drag-block="true"
            >
              {previewMode ? (
                <span className={styles.conversationSectionActionTooltipWrap}>
                  <BareIconButton
                    className={styles.conversationSectionMoreButton}
                    aria-label={createConversationLabel}
                    size="sm"
                    disabled={createConversationDisabled}
                    onClick={handleCreateConversation}
                  >
                    <CreateChatIcon aria-hidden="true" />
                  </BareIconButton>
                </span>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={styles.conversationSectionActionTooltipWrap}
                    >
                      <BareIconButton
                        className={styles.conversationSectionMoreButton}
                        aria-label={createConversationLabel}
                        size="sm"
                        disabled={createConversationDisabled}
                        onClick={handleCreateConversation}
                      >
                        <CreateChatIcon aria-hidden="true" />
                      </BareIconButton>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={6}
                    className={styles.conversationSectionActionTooltip}
                  >
                    {createConversationLabel}
                  </TooltipContent>
                </Tooltip>
              )}
              {projectPath ? (
                <DropdownMenu onOpenChange={handleProjectMenuOpenChange}>
                  {previewMode ? (
                    <DropdownMenuTrigger asChild>
                      <span
                        className={styles.conversationSectionActionTooltipWrap}
                      >
                        <BareIconButton
                          className={styles.conversationSectionMoreButton}
                          aria-label={labels.projectSectionMoreActions}
                          size="sm"
                          disabled={isProjectActionLocked()}
                        >
                          <MoreHorizontalIcon aria-hidden="true" />
                        </BareIconButton>
                      </span>
                    </DropdownMenuTrigger>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={
                            styles.conversationSectionActionTooltipWrap
                          }
                        >
                          <DropdownMenuTrigger asChild>
                            <BareIconButton
                              className={styles.conversationSectionMoreButton}
                              aria-label={labels.projectSectionMoreActions}
                              size="sm"
                              disabled={isProjectActionLocked()}
                            >
                              <MoreHorizontalIcon aria-hidden="true" />
                            </BareIconButton>
                          </DropdownMenuTrigger>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent
                        side="right"
                        sideOffset={6}
                        className={styles.conversationSectionActionTooltip}
                      >
                        {labels.projectSectionMoreActions}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <DropdownMenuContent
                    align="end"
                    className={`${styles.composerMenuContent} nodrag [-webkit-app-region:no-drag]`}
                    sideOffset={6}
                  >
                    <DropdownMenuItem
                      className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                      disabled={!onOpenProjectFiles}
                      onSelect={() => {
                        if (isRailInteractionLocked()) return;
                        onOpenProjectFiles?.({
                          directoryPath: projectPath,
                          mode: "open-directory",
                          path: projectPath,
                          source: "agent-project-menu",
                          type: "open-workspace-file",
                          workspaceRoot: projectPath
                        });
                      }}
                    >
                      <span>{labels.projectSectionViewFiles}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                      disabled={!projectId || isProjectActionLocked()}
                      onSelect={() => {
                        if (!projectId || isProjectActionLocked()) return;
                        void onToggleProjectPinned(projectId, !projectPinned);
                      }}
                    >
                      <span>
                        {projectPinned
                          ? labels.unpinProject
                          : labels.pinProject}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                      disabled={
                        isConversationSearchActive ||
                        (section.items.length === 0 && !sectionHasMore) ||
                        isDeletingProjectConversations ||
                        isRequestingBatchDeletion
                      }
                      onSelect={() => {
                        if (!isRailInteractionLocked()) {
                          onRequestSectionBatchDeletion(section);
                        }
                      }}
                    >
                      <span>{labels.batchDeleteProjectSessions}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                      disabled={isProjectActionLocked()}
                      onSelect={() => {
                        if (isProjectActionLocked()) return;
                        const label = projectLabel || projectPath;
                        setPendingProjectAction({
                          kind: "remove",
                          label,
                          path: projectPath
                        });
                      }}
                    >
                      <span>{labels.removeProject}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {!projectPath && section.kind === "conversations" ? (
                <DropdownMenu>
                  {previewMode ? (
                    <DropdownMenuTrigger asChild>
                      <span
                        className={styles.conversationSectionActionTooltipWrap}
                      >
                        <BareIconButton
                          className={styles.conversationSectionMoreButton}
                          aria-label={labels.conversationsSectionMoreActions}
                          size="sm"
                        >
                          <MoreHorizontalIcon aria-hidden="true" />
                        </BareIconButton>
                      </span>
                    </DropdownMenuTrigger>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={
                            styles.conversationSectionActionTooltipWrap
                          }
                        >
                          <DropdownMenuTrigger asChild>
                            <BareIconButton
                              className={styles.conversationSectionMoreButton}
                              aria-label={
                                labels.conversationsSectionMoreActions
                              }
                              size="sm"
                            >
                              <MoreHorizontalIcon aria-hidden="true" />
                            </BareIconButton>
                          </DropdownMenuTrigger>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent
                        side="right"
                        sideOffset={6}
                        className={styles.conversationSectionActionTooltip}
                      >
                        {labels.conversationsSectionMoreActions}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <DropdownMenuContent
                    align="end"
                    className={`${styles.composerMenuContent} nodrag [-webkit-app-region:no-drag]`}
                    sideOffset={6}
                  >
                    <DropdownMenuItem
                      className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                      disabled={
                        isConversationSearchActive ||
                        (section.items.length === 0 && !sectionHasMore) ||
                        isDeletingProjectConversations ||
                        isRequestingBatchDeletion
                      }
                      onSelect={() => {
                        if (!isRailInteractionLocked()) {
                          onRequestSectionBatchDeletion(section);
                        }
                      }}
                    >
                      <span>{labels.batchDeleteConversations}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ) : null}
        </div>
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
                currentTimeMs={currentTimeMs}
                isDeletingConversation={isDeletingConversation}
                isPendingDeleteConversation={
                  pendingDeleteConversationId === item.id
                }
                isRailInteractionLocked={isRailInteractionLocked}
                item={item}
                labels={labels}
                previewMode={previewMode}
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
