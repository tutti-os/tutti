import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { ExternalLink } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  IssueIcon,
  NewWorkspaceLinedIcon,
  cn
} from "@tutti-os/ui-system";
import { BareIconButton } from "@tutti-os/ui-system/components";
import { WorkspaceUserProjectSelect } from "@tutti-os/workspace-user-project/ui";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { CanvasNodeTrashLinedIcon } from "../../shared/canvasNodeChromeIcons";
import { PinFilledIcon } from "../../../app/renderer/components/icons/PinFilledIcon";
import { PinLinedIcon } from "../../../app/renderer/components/icons/PinLinedIcon";
import {
  useAgentHostApi,
  useOptionalAgentHostApi
} from "../../../agentActivityHost";
import { resolveAgentGuiSessionProviderFlatIconUrl } from "../../../agentGuiSessionProviderIconUrls";
import {
  resolveAgentTargetPresentation,
  useAgentTargetPresentations
} from "../../../shared/AgentTargetPresentationContext";
import { createAgentSessionMarkdownLink } from "../agentRichText/agentFileMentionExtension";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import styles from "../AgentGUINode.styles";
import { conversationPlainTitle } from "./agentGUIViewUtils";
import { AgentGUIConversationRailRelativeTime } from "./AgentGUIConversationRailClock";

function agentGUIConversationIconUrl(
  provider: string | undefined,
  agentTargetId: string | null | undefined,
  workspaceId: string,
  agentTargets: ReturnType<typeof useAgentTargetPresentations>
): string | null {
  const targetPresentation = resolveAgentTargetPresentation({
    agentTargetId: agentTargetId ?? "",
    agentTargets,
    workspaceId
  });
  const targetIconUrl =
    targetPresentation?.maskIconUrl?.trim() ||
    targetPresentation?.iconUrl?.trim();
  return targetIconUrl || resolveAgentGuiSessionProviderFlatIconUrl(provider);
}

function agentGUIConversationRailTitle(
  item: AgentGUINodeViewModel["rail"]["conversations"][number],
  labels: AgentGUIConversationRailLabels,
  uiLanguage: UiLanguage
): string {
  const title = conversationPlainTitle(item, labels, uiLanguage);
  // Only the task kind renders a leading mention icon, so only its "@" prefix
  // is dropped; every other kind (file included) keeps its plain "@" text.
  return item.titleLeadingMentionKind === "task"
    ? title.replace(/^@\s*/, "")
    : title;
}

interface AgentGUIConversationRailItemProps {
  item: AgentGUINodeViewModel["rail"]["conversations"][number];
  active: boolean;
  isPendingDeleteConversation: boolean;
  isDeletingConversation: boolean;
  isRailInteractionLocked: () => boolean;
  labels: AgentGUIConversationRailLabels;
  previewMode: boolean;
  uiLanguage: UiLanguage;
  workspaceId: string;
  registerItemElement: (itemId: string, element: HTMLDivElement | null) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (
    conversation: AgentGUINodeViewModel["rail"]["conversations"][number]
  ) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
}

export const AgentGUIConversationRailItem = memo(
  function AgentGUIConversationRailItem({
    item,
    active,
    isPendingDeleteConversation,
    isDeletingConversation,
    isRailInteractionLocked,
    labels,
    previewMode,
    uiLanguage,
    workspaceId,
    registerItemElement,
    onSelectConversation,
    onToggleConversationPinned,
    onMarkConversationUnread,
    onOpenConversationWindow,
    onRequestDeleteConversation,
    onRequestRenameConversation,
    onCancelDeleteConversation,
    onConfirmDeleteConversation
  }: AgentGUIConversationRailItemProps): React.JSX.Element {
    "use memo";
    const pinned = (item.pinnedAtUnixMs ?? 0) > 0;
    const agentTargets = useAgentTargetPresentations();
    const conversationIconUrl = agentGUIConversationIconUrl(
      item.provider,
      item.agentTargetId,
      workspaceId,
      agentTargets
    );
    const setItemElement = useCallback(
      (element: HTMLDivElement | null) => {
        registerItemElement(item.id, element);
      },
      [item.id, registerItemElement]
    );
    const [contextMenuResetKey, setContextMenuResetKey] = useState(0);
    const [contextMenuOpen, setContextMenuOpen] = useState(false);
    const contextMenuRenameRequestedRef = useRef(false);
    const contextMenuOpenConversationWindowRequestedRef = useRef(false);
    const contextMenuCopySessionLinkRequestedRef = useRef(false);
    const agentHostApi = useOptionalAgentHostApi();
    const handleMouseLeave = useCallback(() => {
      if (isPendingDeleteConversation && !isRailInteractionLocked()) {
        onCancelDeleteConversation();
      }
    }, [
      isPendingDeleteConversation,
      isRailInteractionLocked,
      onCancelDeleteConversation
    ]);
    const handleSelect = useCallback(() => {
      if (isRailInteractionLocked()) return;
      onSelectConversation(item.id);
    }, [isRailInteractionLocked, item.id, onSelectConversation]);
    const handleTogglePinned = useCallback(() => {
      if (isRailInteractionLocked()) return;
      onToggleConversationPinned(item.id, !pinned);
    }, [isRailInteractionLocked, item.id, onToggleConversationPinned, pinned]);
    const canMarkUnread = Boolean(
      !previewMode &&
      !item.hasUnreadCompletion &&
      item.isImported !== true &&
      (item.unreadCompletionKey ||
        item.status === "completed" ||
        item.status === "ready")
    );
    const handleMarkUnread = useCallback(() => {
      if (!canMarkUnread || isRailInteractionLocked()) {
        return;
      }
      onMarkConversationUnread(item.id);
    }, [
      canMarkUnread,
      isRailInteractionLocked,
      item.id,
      onMarkConversationUnread
    ]);
    const handleOpenConversationWindow = useCallback(() => {
      if (isRailInteractionLocked()) return;
      onOpenConversationWindow?.(item.id);
    }, [isRailInteractionLocked, item.id, onOpenConversationWindow]);
    const handleRequestDelete = useCallback(() => {
      if (isRailInteractionLocked()) return;
      onRequestDeleteConversation(item.id);
    }, [isRailInteractionLocked, item.id, onRequestDeleteConversation]);
    const handleRequestRename = useCallback(() => {
      if (isRailInteractionLocked()) return;
      onRequestRenameConversation(item);
    }, [isRailInteractionLocked, item, onRequestRenameConversation]);
    const handleContextMenuRename = useCallback(() => {
      if (isRailInteractionLocked() || contextMenuRenameRequestedRef.current) {
        return;
      }
      contextMenuRenameRequestedRef.current = true;
      setContextMenuOpen(false);
      setContextMenuResetKey((key) => key + 1);
      // timing: defer past the context menu's own close/dismiss handling
      window.setTimeout(() => {
        if (isRailInteractionLocked()) {
          contextMenuRenameRequestedRef.current = false;
          return;
        }
        handleRequestRename();
        contextMenuRenameRequestedRef.current = false;
      }, 0);
    }, [handleRequestRename, isRailInteractionLocked]);
    const handleContextMenuOpenConversationWindow = useCallback(() => {
      if (
        isRailInteractionLocked() ||
        contextMenuOpenConversationWindowRequestedRef.current
      ) {
        return;
      }
      contextMenuOpenConversationWindowRequestedRef.current = true;
      setContextMenuOpen(false);
      setContextMenuResetKey((key) => key + 1);
      // timing: defer past the context menu's own close/dismiss handling
      window.setTimeout(() => {
        if (isRailInteractionLocked()) {
          contextMenuOpenConversationWindowRequestedRef.current = false;
          return;
        }
        handleOpenConversationWindow();
        contextMenuOpenConversationWindowRequestedRef.current = false;
      }, 0);
    }, [handleOpenConversationWindow, isRailInteractionLocked]);
    const handleContextMenuCopySessionLink = useCallback(() => {
      if (
        isRailInteractionLocked() ||
        contextMenuCopySessionLinkRequestedRef.current
      ) {
        return;
      }
      contextMenuCopySessionLinkRequestedRef.current = true;
      setContextMenuOpen(false);
      setContextMenuResetKey((key) => key + 1);
      // timing: defer past the context menu's own close/dismiss handling
      window.setTimeout(() => {
        if (isRailInteractionLocked()) {
          contextMenuCopySessionLinkRequestedRef.current = false;
          return;
        }
        if (!agentHostApi?.clipboard?.writeText) {
          contextMenuCopySessionLinkRequestedRef.current = false;
          return;
        }
        const title = conversationPlainTitle(item, labels, uiLanguage);
        const markdown = createAgentSessionMarkdownLink({
          agentSessionId: item.id,
          agentTargetId: item.agentTargetId,
          label: title,
          workspaceId,
          withAtPrefix: false
        });
        void agentHostApi.clipboard
          .writeText(markdown)
          .catch(() => undefined)
          .finally(() => {
            contextMenuCopySessionLinkRequestedRef.current = false;
          });
      }, 0);
    }, [
      agentHostApi,
      isRailInteractionLocked,
      item,
      labels,
      uiLanguage,
      workspaceId
    ]);
    const row = (
      <div
        ref={setItemElement}
        className={styles.conversationItem}
        data-active={active}
        data-pinned={pinned}
        data-pending-delete={isPendingDeleteConversation}
        data-testid={`agent-gui-conversation-item-${item.id}`}
        onContextMenuCapture={(event) => {
          if (isRailInteractionLocked()) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onMouseLeave={handleMouseLeave}
      >
        <button
          type="button"
          className={styles.conversationSelect}
          onClick={handleSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            handleRequestRename();
          }}
        >
          <span className={styles.conversationTitleRow}>
            {conversationIconUrl ? (
              <span
                aria-hidden="true"
                className={styles.conversationProviderIcon}
                style={
                  {
                    "--agent-gui-conversation-provider-icon-url": `url("${conversationIconUrl}")`
                  } as CSSProperties
                }
              />
            ) : null}
            {item.titleLeadingMentionKind === "task" ? (
              <span
                aria-hidden="true"
                className={styles.conversationTitleMentionIcon}
                data-agent-gui-conversation-title-mention-icon={
                  item.titleLeadingMentionKind
                }
              >
                <IssueIcon />
              </span>
            ) : null}
            <span className={styles.conversationTitle}>
              {agentGUIConversationRailTitle(item, labels, uiLanguage)}
            </span>
          </span>
          <AgentGUIConversationRailRelativeTime item={item} labels={labels} />
        </button>
        {previewMode ? null : (
          <div className={styles.conversationActions}>
            {isPendingDeleteConversation ? (
              <button
                type="button"
                className={styles.conversationDeleteButton}
                aria-label={labels.deleteSessionConfirm}
                title={labels.deleteSessionConfirm}
                disabled={isDeletingConversation}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!isRailInteractionLocked()) {
                    onConfirmDeleteConversation();
                  }
                }}
              >
                <span className={styles.conversationDeleteConfirmText}>
                  {labels.deleteSessionConfirm}
                </span>
              </button>
            ) : (
              <>
                {onOpenConversationWindow ? (
                  <BareIconButton
                    className={styles.conversationOpenWindowButton}
                    aria-label={labels.openConversationWindow}
                    title={labels.openConversationWindow}
                    size="md"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleOpenConversationWindow();
                    }}
                  >
                    <ExternalLink aria-hidden="true" />
                  </BareIconButton>
                ) : null}
                <BareIconButton
                  className={styles.conversationPinButton}
                  aria-label={pinned ? labels.unpinSession : labels.pinSession}
                  title={pinned ? labels.unpinSession : labels.pinSession}
                  size="md"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleTogglePinned();
                  }}
                >
                  {pinned ? (
                    <PinFilledIcon aria-hidden="true" />
                  ) : (
                    <PinLinedIcon aria-hidden="true" />
                  )}
                </BareIconButton>
                <BareIconButton
                  className={styles.conversationDeleteButton}
                  aria-label={labels.deleteSession}
                  title={labels.deleteSession}
                  size="md"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleRequestDelete();
                  }}
                >
                  <CanvasNodeTrashLinedIcon aria-hidden="true" />
                </BareIconButton>
              </>
            )}
          </div>
        )}
      </div>
    );
    if (previewMode) {
      return row;
    }
    return (
      <ContextMenu key={contextMenuResetKey} onOpenChange={setContextMenuOpen}>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        {contextMenuOpen ? (
          <ContextMenuContent
            className={`${styles.composerMenuContent} nodrag [-webkit-app-region:no-drag]`}
          >
            <ContextMenuItem
              className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
              onClick={handleContextMenuRename}
              onPointerUp={(event) => {
                if (event.button === 0) {
                  handleContextMenuRename();
                }
              }}
              onSelect={handleContextMenuRename}
            >
              <span>{labels.renameSession}</span>
            </ContextMenuItem>
            {onOpenConversationWindow ? (
              <ContextMenuItem
                className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                onClick={handleContextMenuOpenConversationWindow}
                onPointerUp={(event) => {
                  if (event.button === 0) {
                    handleContextMenuOpenConversationWindow();
                  }
                }}
                onSelect={handleContextMenuOpenConversationWindow}
              >
                <span>{labels.openConversationWindow}</span>
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem
              className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
              onClick={handleContextMenuCopySessionLink}
              onPointerUp={(event) => {
                if (event.button === 0) {
                  handleContextMenuCopySessionLink();
                }
              }}
              onSelect={handleContextMenuCopySessionLink}
            >
              <span>{labels.copySessionLink}</span>
            </ContextMenuItem>
            <ContextMenuItem
              className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
              disabled={!canMarkUnread}
              onSelect={handleMarkUnread}
            >
              <span>{labels.markSessionUnread}</span>
            </ContextMenuItem>
          </ContextMenuContent>
        ) : null}
      </ContextMenu>
    );
  }
);

export function AgentGUIProjectRailHeader({
  disabled,
  labels,
  selectProjectDirectory,
  workspaceUserProjectI18n
}: {
  disabled?: boolean;
  labels: Pick<
    AgentGUIConversationRailLabels,
    "projectRailCreateProject" | "projectRailLinkExistingProject"
  >;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
}): React.JSX.Element {
  "use memo";
  const agentHostApi = useAgentHostApi();
  const userProjectApi = useMemo(
    () =>
      agentHostApi.userProjects
        ? {
            ...agentHostApi.userProjects,
            selectDirectory:
              selectProjectDirectory ?? agentHostApi.workspace.selectDirectory
          }
        : null,
    [
      agentHostApi.userProjects,
      agentHostApi.workspace.selectDirectory,
      selectProjectDirectory
    ]
  );

  return (
    <div className={styles.projectRailHeader}>
      <div className={styles.projectRailTitle}>
        <span>
          {workspaceUserProjectI18n.tFirst(["projectSelect.projectLabel"])}
        </span>
      </div>
      <div className={styles.projectRailAddProject}>
        <WorkspaceUserProjectSelect
          api={userProjectApi}
          classNames={{
            content: cn(
              styles.composerMenuContent,
              "w-[240px] min-w-[240px] nodrag [-webkit-app-region:no-drag]"
            ),
            item: cn(
              styles.composerMenuItem,
              "nodrag [-webkit-app-region:no-drag]"
            ),
            trigger: cn(
              styles.projectRailAddProjectTrigger,
              "nodrag [-webkit-app-region:no-drag]"
            )
          }}
          contentAlign="end"
          contentSide="bottom"
          contentSideOffset={6}
          disabled={disabled}
          i18n={workspaceUserProjectI18n}
          labels={{
            addProject: labels.projectRailCreateProject,
            createProjectTitle: labels.projectRailCreateProject,
            linkExistingProject: labels.projectRailLinkExistingProject,
            projectLabel: workspaceUserProjectI18n.tFirst([
              "projectSelect.addProject"
            ])
          }}
          renderAddProjectIcon={() => (
            <NewWorkspaceLinedIcon
              aria-hidden
              data-workspace-user-project-add-icon="true"
              size={15}
            />
          )}
          selectedProjectPath={null}
          service={agentHostApi.userProjects?.service ?? null}
          shouldApplyPreparedSelection={false}
          showCreateProjectAction
          showKnownProjectOptions={false}
          showNoProjectAction={false}
          onProjectPathChange={() => {}}
        />
        <NewWorkspaceLinedIcon
          aria-hidden
          className={styles.projectRailAddProjectIcon}
        />
      </div>
    </div>
  );
}
