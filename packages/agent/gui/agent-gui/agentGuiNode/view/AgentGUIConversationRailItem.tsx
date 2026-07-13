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
import { ConversationMeta } from "../agentGuiNodeViewConversation";
import { createAgentSessionMarkdownLink } from "../agentRichText/agentFileMentionExtension";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import styles from "../AgentGUINode.styles";
import { conversationPlainTitle } from "./agentGUIViewUtils";

function agentGUIConversationProviderIconUrl(
  provider: string | undefined
): string | null {
  return resolveAgentGuiSessionProviderFlatIconUrl(provider);
}

interface AgentGUIConversationRailItemProps {
  item: AgentGUINodeViewModel["rail"]["conversations"][number];
  active: boolean;
  isPendingDeleteConversation: boolean;
  isDeletingConversation: boolean;
  currentTimeMs: number;
  labels: AgentGUIViewLabels;
  previewMode: boolean;
  uiLanguage: UiLanguage;
  workspaceId: string;
  registerItemElement: (itemId: string, element: HTMLDivElement | null) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (agentSessionId: string) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
}

export const AgentGUIConversationRailItem = memo(
  function AgentGUIConversationRailItem({
    item,
    active,
    isPendingDeleteConversation,
    isDeletingConversation,
    currentTimeMs,
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
    const providerIconUrl = agentGUIConversationProviderIconUrl(item.provider);
    const setItemElement = useCallback(
      (element: HTMLDivElement | null) => {
        registerItemElement(item.id, element);
      },
      [item.id, registerItemElement]
    );
    const [contextMenuResetKey, setContextMenuResetKey] = useState(0);
    const contextMenuRenameRequestedRef = useRef(false);
    const contextMenuOpenConversationWindowRequestedRef = useRef(false);
    const contextMenuCopySessionLinkRequestedRef = useRef(false);
    const agentHostApi = useOptionalAgentHostApi();
    const handleMouseLeave = useCallback(() => {
      if (isPendingDeleteConversation) {
        onCancelDeleteConversation();
      }
    }, [isPendingDeleteConversation, onCancelDeleteConversation]);
    const handleSelect = useCallback(() => {
      onSelectConversation(item.id);
    }, [item.id, onSelectConversation]);
    const handleTogglePinned = useCallback(() => {
      onToggleConversationPinned(item.id, !pinned);
    }, [item.id, onToggleConversationPinned, pinned]);
    const canMarkUnread = Boolean(
      !previewMode &&
      !item.hasUnreadCompletion &&
      item.isImported !== true &&
      (item.unreadCompletionKey ||
        item.status === "completed" ||
        item.status === "ready")
    );
    const handleMarkUnread = useCallback(() => {
      if (!canMarkUnread) {
        return;
      }
      onMarkConversationUnread(item.id);
    }, [canMarkUnread, item.id, onMarkConversationUnread]);
    const handleOpenConversationWindow = useCallback(() => {
      onOpenConversationWindow?.(item.id);
    }, [item.id, onOpenConversationWindow]);
    const handleRequestDelete = useCallback(() => {
      onRequestDeleteConversation(item.id);
    }, [item.id, onRequestDeleteConversation]);
    const handleRequestRename = useCallback(() => {
      onRequestRenameConversation(item.id);
    }, [item.id, onRequestRenameConversation]);
    const handleContextMenuRename = useCallback(() => {
      if (contextMenuRenameRequestedRef.current) {
        return;
      }
      contextMenuRenameRequestedRef.current = true;
      setContextMenuResetKey((key) => key + 1);
      // timing: defer past the context menu's own close/dismiss handling
      window.setTimeout(() => {
        handleRequestRename();
        contextMenuRenameRequestedRef.current = false;
      }, 0);
    }, [handleRequestRename]);
    const handleContextMenuOpenConversationWindow = useCallback(() => {
      if (contextMenuOpenConversationWindowRequestedRef.current) {
        return;
      }
      contextMenuOpenConversationWindowRequestedRef.current = true;
      setContextMenuResetKey((key) => key + 1);
      // timing: defer past the context menu's own close/dismiss handling
      window.setTimeout(() => {
        handleOpenConversationWindow();
        contextMenuOpenConversationWindowRequestedRef.current = false;
      }, 0);
    }, [handleOpenConversationWindow]);
    const handleContextMenuCopySessionLink = useCallback(() => {
      if (contextMenuCopySessionLinkRequestedRef.current) {
        return;
      }
      contextMenuCopySessionLinkRequestedRef.current = true;
      setContextMenuResetKey((key) => key + 1);
      // timing: defer past the context menu's own close/dismiss handling
      window.setTimeout(() => {
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
    }, [agentHostApi, item, labels, uiLanguage, workspaceId]);
    const row = (
      <div
        ref={setItemElement}
        className={styles.conversationItem}
        data-active={active}
        data-pinned={pinned}
        data-pending-delete={isPendingDeleteConversation}
        data-testid={`agent-gui-conversation-item-${item.id}`}
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
            {providerIconUrl ? (
              <span
                aria-hidden="true"
                className={styles.conversationProviderIcon}
                style={
                  {
                    "--agent-gui-conversation-provider-icon-url": `url("${providerIconUrl}")`
                  } as CSSProperties
                }
              />
            ) : null}
            <span className={styles.conversationTitle}>
              {conversationPlainTitle(item, labels, uiLanguage)}
            </span>
          </span>
          <ConversationMeta item={item} nowMs={currentTimeMs} labels={labels} />
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
                  onConfirmDeleteConversation();
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
      <ContextMenu key={contextMenuResetKey}>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
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
      </ContextMenu>
    );
  }
);

export function AgentGUIProjectRailHeader({
  labels,
  selectProjectDirectory,
  workspaceUserProjectI18n
}: {
  labels: Pick<
    AgentGUIViewLabels,
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
