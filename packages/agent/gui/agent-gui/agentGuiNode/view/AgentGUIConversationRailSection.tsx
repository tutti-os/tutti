import { memo, useCallback, useState } from "react";
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
import styles from "../AgentGUINode.styles";

const AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE = 5;

interface AgentGUIConversationRailSectionProps {
  section: ConversationSection;
  activeConversation: ConversationSection["items"][number] | null;
  activeConversationCountsTowardTotal: boolean;
  paginationScopeKey: string;
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
  sectionHasMore: boolean;
  sectionTotalCount: number;
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
  onRequestSectionBatchDeletion: (section: ConversationSection) => void;
  setPendingProjectAction: (action: AgentGUIProjectActionDialog | null) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onLoadMoreConversations: (section: ConversationSection) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenProjectFiles?: ((action: WorkspaceLinkAction) => void) | null;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (
    conversation: ConversationSection["items"][number]
  ) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
}

export const AgentGUIConversationRailSection = memo(
  function AgentGUIConversationRailSection({
    section,
    activeConversation,
    activeConversationCountsTowardTotal,
    paginationScopeKey,
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
    sectionHasMore,
    sectionTotalCount,
    createConversationDisabled,
    currentTimeMs,
    labels,
    uiLanguage,
    workspaceId,
    registerItemElement,
    onCreateConversation,
    onToggleProjectSectionCollapsed,
    onSelectConversation,
    onLoadMoreConversations,
    onRequestSectionBatchDeletion,
    setPendingProjectAction,
    onToggleConversationPinned,
    onMarkConversationUnread,
    onOpenProjectFiles,
    onOpenConversationWindow,
    onRequestDeleteConversation,
    onRequestRenameConversation,
    onCancelDeleteConversation,
    onConfirmDeleteConversation
  }: AgentGUIConversationRailSectionProps): React.JSX.Element {
    "use memo";
    const isProjectSection = section.kind === "project";
    const [visibleItemLimitState, setVisibleItemLimitState] = useState(() => ({
      limit: AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
      scopeKey: paginationScopeKey
    }));
    if (visibleItemLimitState.scopeKey !== paginationScopeKey) {
      setVisibleItemLimitState({
        limit: AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
        scopeKey: paginationScopeKey
      });
    }
    const visibleItemLimit =
      visibleItemLimitState.scopeKey === paginationScopeKey
        ? visibleItemLimitState.limit
        : AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE;
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
      if (visibleItemCount >= pageableItems.length && sectionHasMore) {
        onLoadMoreConversations(section);
        setVisibleItemLimitState((current) => ({
          limit:
            (current.scopeKey === paginationScopeKey
              ? current.limit
              : AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE) +
            AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
          scopeKey: paginationScopeKey
        }));
        return;
      }
      setVisibleItemLimitState((current) => ({
        limit: Math.min(
          pageableItems.length,
          (current.scopeKey === paginationScopeKey
            ? current.limit
            : AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE) +
            AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
        ),
        scopeKey: paginationScopeKey
      }));
    }, [
      onLoadMoreConversations,
      pageableItems.length,
      paginationScopeKey,
      section,
      sectionHasMore,
      visibleItemCount
    ]);
    const showLessConversations = useCallback(() => {
      setVisibleItemLimitState({
        limit: AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
        scopeKey: paginationScopeKey
      });
    }, [paginationScopeKey]);

    const canCreateConversationFromSection =
      section.kind === "conversations" || Boolean(projectPath);
    const createConversationLabel = projectPath
      ? labels.projectSectionEdit
      : labels.newConversation;
    const handleCreateConversation = useCallback(() => {
      if (projectPath) {
        onCreateConversation({ projectPath, source: "project_section" });
        return;
      }
      onCreateConversation({
        projectPath: null,
        source: "unscoped_section"
      });
    }, [onCreateConversation, projectPath]);

    return (
      <section
        className={styles.conversationSection}
        data-collapsed={isSectionCollapsed}
        data-kind={section.kind}
      >
        <div className={styles.conversationSectionHeader}>
          {isProjectSection ? (
            <button
              type="button"
              className={styles.conversationSectionToggle}
              aria-expanded={!isSectionCollapsed}
              onClick={() => onToggleProjectSectionCollapsed(section.id)}
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
                  />
                ) : (
                  <FolderOpenLinedIcon
                    aria-hidden="true"
                    className={styles.conversationSectionLabelIcon}
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
            <div className={styles.conversationSectionActions}>
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
                <DropdownMenu>
                  {previewMode ? (
                    <DropdownMenuTrigger asChild>
                      <span
                        className={styles.conversationSectionActionTooltipWrap}
                      >
                        <BareIconButton
                          className={styles.conversationSectionMoreButton}
                          aria-label={labels.projectSectionMoreActions}
                          size="sm"
                        >
                          <MoreHorizontalIcon aria-hidden="true" />
                        </BareIconButton>
                      </span>
                    </DropdownMenuTrigger>
                  ) : (
                    <Tooltip>
                      <DropdownMenuTrigger asChild>
                        <TooltipTrigger asChild>
                          <span
                            className={
                              styles.conversationSectionActionTooltipWrap
                            }
                          >
                            <BareIconButton
                              className={styles.conversationSectionMoreButton}
                              aria-label={labels.projectSectionMoreActions}
                              size="sm"
                            >
                              <MoreHorizontalIcon aria-hidden="true" />
                            </BareIconButton>
                          </span>
                        </TooltipTrigger>
                      </DropdownMenuTrigger>
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
                      disabled={
                        isConversationSearchActive ||
                        (section.items.length === 0 && !sectionHasMore) ||
                        isDeletingProjectConversations ||
                        isRequestingBatchDeletion
                      }
                      onSelect={() => onRequestSectionBatchDeletion(section)}
                    >
                      <span>{labels.batchDeleteProjectSessions}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                      onSelect={() => {
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
                      <DropdownMenuTrigger asChild>
                        <TooltipTrigger asChild>
                          <span
                            className={
                              styles.conversationSectionActionTooltipWrap
                            }
                          >
                            <BareIconButton
                              className={styles.conversationSectionMoreButton}
                              aria-label={
                                labels.conversationsSectionMoreActions
                              }
                              size="sm"
                            >
                              <MoreHorizontalIcon aria-hidden="true" />
                            </BareIconButton>
                          </span>
                        </TooltipTrigger>
                      </DropdownMenuTrigger>
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
                      onSelect={() => onRequestSectionBatchDeletion(section)}
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
