import { forwardRef, memo, useCallback, useState } from "react";
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
import {
  BareIconButton,
  type BareIconButtonProps
} from "@tutti-os/ui-system/components";
import {
  CreateChatIcon,
  FolderIcon,
  FolderOpenLinedIcon,
  MoreHorizontalIcon
} from "@tutti-os/ui-system/icons";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import styles from "../AgentGUINode.styles";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import {
  useAgentGUIConversationRailSectionBatchDeletionDisabled,
  useAgentGUIConversationRailSectionProjectActionLocked,
  useAgentGUIConversationRailSectionProjectDragDisabled
} from "./agentGUIConversationRailSectionPresentationContext";

interface AgentGUIConversationRailSectionHeaderProps {
  canCreateConversation: boolean;
  createConversationDisabled: boolean;
  createConversationLabel: string;
  hasProjectId: boolean;
  hasProjectPath: boolean;
  isSectionCollapsed: boolean;
  kind: ConversationSection["kind"];
  labels: AgentGUIConversationRailLabels;
  onCreateConversation: () => void;
  onOpenProjectFiles?: (() => void) | null;
  onProjectDragEnd: () => void;
  onProjectDragStart: (event: React.DragEvent<HTMLElement>) => void;
  onProjectMenuOpenChange: (open: boolean) => void;
  onRemoveProject: () => void;
  onRequestBatchDeletion: () => void;
  onToggleCollapsed: () => void;
  onToggleProjectPinned: () => void;
  projectPinned: boolean;
  sectionLabel: string;
}

interface HeaderFrameProps {
  children: React.ReactNode;
  isProjectSection: boolean;
  onProjectDragEnd: () => void;
  onProjectDragStart: (event: React.DragEvent<HTMLElement>) => void;
}

function HeaderFrame({
  children,
  isProjectSection,
  onProjectDragEnd,
  onProjectDragStart
}: HeaderFrameProps): React.JSX.Element {
  const projectDragDisabled =
    useAgentGUIConversationRailSectionProjectDragDisabled();

  return (
    <div
      className={styles.conversationSectionHeader}
      draggable={isProjectSection && !projectDragDisabled}
      onDragStart={onProjectDragStart}
      onDragEnd={onProjectDragEnd}
    >
      {children}
    </div>
  );
}

interface HeaderIdentityProps {
  isProjectSection: boolean;
  isSectionCollapsed: boolean;
  labels: AgentGUIConversationRailLabels;
  onToggleCollapsed: () => void;
  projectPinned: boolean;
  sectionLabel: string;
}

const HeaderIdentity = memo(function HeaderIdentity({
  isProjectSection,
  isSectionCollapsed,
  labels,
  onToggleCollapsed,
  projectPinned,
  sectionLabel
}: HeaderIdentityProps): React.JSX.Element {
  "use memo";
  if (!isProjectSection) {
    return (
      <div className={styles.conversationSectionToggle}>
        <span className={styles.conversationSectionLabel}>
          <span>{sectionLabel}</span>
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={styles.conversationSectionToggle}
      aria-expanded={!isSectionCollapsed}
      aria-label={
        projectPinned
          ? labels.pinnedProjectAccessibleName(sectionLabel)
          : sectionLabel
      }
      onClick={onToggleCollapsed}
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
        <span>{sectionLabel}</span>
      </span>
    </button>
  );
});

interface CreateActionProps {
  createConversationDisabled: boolean;
  createConversationLabel: string;
  onCreateConversation: () => void;
}

const CreateAction = memo(function CreateAction({
  createConversationDisabled,
  createConversationLabel,
  onCreateConversation
}: CreateActionProps): React.JSX.Element {
  "use memo";
  const button = (
    <BareIconButton
      className={styles.conversationSectionMoreButton}
      aria-label={createConversationLabel}
      size="sm"
      title=""
      disabled={createConversationDisabled}
      onClick={onCreateConversation}
    >
      <CreateChatIcon aria-hidden="true" />
    </BareIconButton>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={styles.conversationSectionActionTooltipWrap}>
          {button}
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
  );
});

interface ProjectMenuTriggerProps {
  labels: AgentGUIConversationRailLabels;
}

type ProjectMenuButtonProps = Omit<
  BareIconButtonProps,
  "aria-label" | "children" | "size"
> & {
  accessibleName: string;
};

const ProjectMenuButton = forwardRef<HTMLButtonElement, ProjectMenuButtonProps>(
  function ProjectMenuButton(
    { accessibleName, disabled, ...props },
    ref
  ): React.JSX.Element {
    const projectActionLocked =
      useAgentGUIConversationRailSectionProjectActionLocked();

    return (
      <BareIconButton
        {...props}
        ref={ref}
        className={styles.conversationSectionMoreButton}
        aria-label={accessibleName}
        size="sm"
        title=""
        disabled={projectActionLocked || disabled}
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </BareIconButton>
    );
  }
);
ProjectMenuButton.displayName = "ProjectMenuButton";

function ProjectMenuTrigger({
  labels
}: ProjectMenuTriggerProps): React.JSX.Element {
  const accessibleName = labels.projectSectionMoreActions;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={styles.conversationSectionActionTooltipWrap}>
          <DropdownMenuTrigger asChild>
            <ProjectMenuButton accessibleName={accessibleName} />
          </DropdownMenuTrigger>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={6}
        className={styles.conversationSectionActionTooltip}
      >
        {accessibleName}
      </TooltipContent>
    </Tooltip>
  );
}

interface ProjectMenuContentProps {
  hasProjectId: boolean;
  labels: AgentGUIConversationRailLabels;
  onOpenProjectFiles?: (() => void) | null;
  onRemoveProject: () => void;
  onRequestBatchDeletion: () => void;
  onToggleProjectPinned: () => void;
  projectPinned: boolean;
}

function ProjectMenuContent({
  hasProjectId,
  labels,
  onOpenProjectFiles,
  onRemoveProject,
  onRequestBatchDeletion,
  onToggleProjectPinned,
  projectPinned
}: ProjectMenuContentProps): React.JSX.Element {
  const batchDeletionDisabled =
    useAgentGUIConversationRailSectionBatchDeletionDisabled();
  const projectActionLocked =
    useAgentGUIConversationRailSectionProjectActionLocked();

  return (
    <DropdownMenuContent
      align="end"
      className={`${styles.composerMenuContent} nodrag [-webkit-app-region:no-drag]`}
      sideOffset={6}
    >
      <DropdownMenuItem
        className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
        disabled={!onOpenProjectFiles}
        onSelect={onOpenProjectFiles ?? undefined}
      >
        <span>{labels.projectSectionViewFiles}</span>
      </DropdownMenuItem>
      <DropdownMenuItem
        className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
        disabled={!hasProjectId || projectActionLocked}
        onSelect={onToggleProjectPinned}
      >
        <span>{projectPinned ? labels.unpinProject : labels.pinProject}</span>
      </DropdownMenuItem>
      <DropdownMenuItem
        className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
        disabled={batchDeletionDisabled}
        onSelect={onRequestBatchDeletion}
      >
        <span>{labels.batchDeleteProjectSessions}</span>
      </DropdownMenuItem>
      <DropdownMenuItem
        className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
        disabled={projectActionLocked}
        onSelect={onRemoveProject}
      >
        <span>{labels.removeProject}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

interface ProjectMenuProps extends ProjectMenuContentProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const ProjectMenu = memo(function ProjectMenu({
  hasProjectId,
  labels,
  onOpenChange,
  onOpenProjectFiles,
  onRemoveProject,
  onRequestBatchDeletion,
  onToggleProjectPinned,
  open,
  projectPinned
}: ProjectMenuProps): React.JSX.Element {
  "use memo";
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <ProjectMenuTrigger labels={labels} />
      {open ? (
        <ProjectMenuContent
          hasProjectId={hasProjectId}
          labels={labels}
          onOpenProjectFiles={onOpenProjectFiles}
          onRemoveProject={onRemoveProject}
          onRequestBatchDeletion={onRequestBatchDeletion}
          onToggleProjectPinned={onToggleProjectPinned}
          projectPinned={projectPinned}
        />
      ) : null}
    </DropdownMenu>
  );
});

interface ConversationMenuTriggerProps {
  labels: AgentGUIConversationRailLabels;
}

function ConversationMenuTrigger({
  labels
}: ConversationMenuTriggerProps): React.JSX.Element {
  const accessibleName = labels.conversationsSectionMoreActions;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={styles.conversationSectionActionTooltipWrap}>
          <DropdownMenuTrigger asChild>
            <BareIconButton
              className={styles.conversationSectionMoreButton}
              aria-label={accessibleName}
              size="sm"
              title=""
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
        {accessibleName}
      </TooltipContent>
    </Tooltip>
  );
}

interface ConversationMenuContentProps {
  labels: AgentGUIConversationRailLabels;
  onRequestBatchDeletion: () => void;
}

function ConversationMenuContent({
  labels,
  onRequestBatchDeletion
}: ConversationMenuContentProps): React.JSX.Element {
  const batchDeletionDisabled =
    useAgentGUIConversationRailSectionBatchDeletionDisabled();

  return (
    <DropdownMenuContent
      align="end"
      className={`${styles.composerMenuContent} nodrag [-webkit-app-region:no-drag]`}
      sideOffset={6}
    >
      <DropdownMenuItem
        className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
        disabled={batchDeletionDisabled}
        onSelect={onRequestBatchDeletion}
      >
        <span>{labels.batchDeleteConversations}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

interface ConversationMenuProps extends ConversationMenuContentProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

function ConversationMenu({
  labels,
  onOpenChange,
  onRequestBatchDeletion,
  open
}: ConversationMenuProps): React.JSX.Element {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <ConversationMenuTrigger labels={labels} />
      {open ? (
        <ConversationMenuContent
          labels={labels}
          onRequestBatchDeletion={onRequestBatchDeletion}
        />
      ) : null}
    </DropdownMenu>
  );
}

export const AgentGUIConversationRailSectionHeader = memo(
  function AgentGUIConversationRailSectionHeader({
    canCreateConversation,
    createConversationDisabled,
    createConversationLabel,
    hasProjectId,
    hasProjectPath,
    isSectionCollapsed,
    kind,
    labels,
    onCreateConversation,
    onOpenProjectFiles,
    onProjectDragEnd,
    onProjectDragStart,
    onProjectMenuOpenChange,
    onRemoveProject,
    onRequestBatchDeletion,
    onToggleCollapsed,
    onToggleProjectPinned,
    projectPinned,
    sectionLabel
  }: AgentGUIConversationRailSectionHeaderProps): React.JSX.Element {
    "use memo";
    const [projectMenuOpen, setProjectMenuOpen] = useState(false);
    const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
    const handleProjectMenuOpenChange = useCallback(
      (open: boolean) => {
        setProjectMenuOpen(open);
        onProjectMenuOpenChange(open);
      },
      [onProjectMenuOpenChange]
    );
    const isProjectSection = kind === "project";

    return (
      <HeaderFrame
        isProjectSection={isProjectSection}
        onProjectDragEnd={onProjectDragEnd}
        onProjectDragStart={onProjectDragStart}
      >
        <HeaderIdentity
          isProjectSection={isProjectSection}
          isSectionCollapsed={isSectionCollapsed}
          labels={labels}
          onToggleCollapsed={onToggleCollapsed}
          projectPinned={projectPinned}
          sectionLabel={sectionLabel}
        />
        {canCreateConversation ? (
          <div
            className={styles.conversationSectionActions}
            data-project-drag-block="true"
          >
            <CreateAction
              createConversationDisabled={createConversationDisabled}
              createConversationLabel={createConversationLabel}
              onCreateConversation={onCreateConversation}
            />
            {hasProjectPath ? (
              <ProjectMenu
                hasProjectId={hasProjectId}
                labels={labels}
                onOpenChange={handleProjectMenuOpenChange}
                onOpenProjectFiles={onOpenProjectFiles}
                onRemoveProject={onRemoveProject}
                onRequestBatchDeletion={onRequestBatchDeletion}
                onToggleProjectPinned={onToggleProjectPinned}
                open={projectMenuOpen}
                projectPinned={projectPinned}
              />
            ) : null}
            {!hasProjectPath && kind === "conversations" ? (
              <ConversationMenu
                labels={labels}
                onOpenChange={setConversationMenuOpen}
                onRequestBatchDeletion={onRequestBatchDeletion}
                open={conversationMenuOpen}
              />
            ) : null}
          </div>
        ) : null}
      </HeaderFrame>
    );
  }
);
