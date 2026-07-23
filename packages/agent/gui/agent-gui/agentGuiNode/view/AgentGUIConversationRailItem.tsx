import { memo, useCallback, useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { NewWorkspaceLinedIcon, cn } from "@tutti-os/ui-system";
import { WorkspaceUserProjectSelect } from "@tutti-os/workspace-user-project/ui";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { BareIconButton } from "@tutti-os/ui-system/components";
import { CanvasNodeTrashLinedIcon } from "../../shared/canvasNodeChromeIcons";
import { PinFilledIcon } from "../../../app/renderer/components/icons/PinFilledIcon";
import { PinLinedIcon } from "../../../app/renderer/components/icons/PinLinedIcon";
import { useAgentHostApi } from "../../../agentActivityHost";
import { createAgentGUIUserProjectSelectionApi } from "../agentGuiUserProjectSelectionApi";
import { resolveAgentGuiSessionProviderFlatIconUrl } from "../../../agentGuiSessionProviderIconUrls";
import {
  resolveAgentTargetPresentation,
  useAgentTargetPresentations
} from "../../../shared/AgentTargetPresentationContext";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import styles from "../AgentGUINode.styles";
import { conversationPlainTitle } from "./agentGUIViewUtils";
import { AgentGUIConversationRailRelativeTime } from "./AgentGUIConversationRailClock";
import {
  AgentGUIConversationActionsContextMenu,
  AgentGUIConversationActionsDropdown,
  useConversationActionGroups
} from "./AgentGUIConversationActionsMenu";

type AgentGUIConversationIconPresentation =
  | { kind: "image"; url: string }
  | { kind: "mask"; url: string };

function agentGUIConversationIconPresentation(
  provider: string | undefined,
  agentTargetId: string | null | undefined,
  workspaceId: string,
  agentTargets: ReturnType<typeof useAgentTargetPresentations>
): AgentGUIConversationIconPresentation | null {
  const targetPresentation = resolveAgentTargetPresentation({
    agentTargetId: agentTargetId ?? "",
    agentTargets,
    workspaceId
  });
  const maskIconUrl = targetPresentation?.maskIconUrl?.trim() ?? "";
  if (maskIconUrl) {
    return { kind: "mask", url: maskIconUrl };
  }
  const iconUrl = targetPresentation?.iconUrl?.trim() ?? "";
  if (iconUrl) {
    return { kind: "image", url: iconUrl };
  }
  const providerIconUrl = resolveAgentGuiSessionProviderFlatIconUrl(provider);
  return providerIconUrl ? { kind: "mask", url: providerIconUrl } : null;
}

function agentGUIConversationRailTitle(
  item: AgentGUINodeViewModel["rail"]["conversations"][number],
  labels: AgentGUIConversationRailLabels,
  uiLanguage: UiLanguage
): string {
  return conversationPlainTitle(item, labels, uiLanguage);
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
    const conversationIcon = agentGUIConversationIconPresentation(
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
    const handleMouseLeave = useCallback(() => {
      if (isPendingDeleteConversation && !isRailInteractionLocked()) {
        onCancelDeleteConversation();
      }
    }, [
      isPendingDeleteConversation,
      isRailInteractionLocked,
      onCancelDeleteConversation
    ]);
    const handleSelect = (): void => {
      if (!isRailInteractionLocked()) {
        onSelectConversation(item.id);
      }
    };
    const handleRequestRename = (): void => {
      if (!isRailInteractionLocked()) {
        onRequestRenameConversation(item);
      }
    };
    // Plain closures on purpose: the component memo budget caps leaf caches
    // at 5 and "use memo" lets the compiler stabilize these.
    const handleTogglePinned = (): void => {
      if (!isRailInteractionLocked()) {
        onToggleConversationPinned(item.id, !pinned);
      }
    };
    const handleRequestDelete = (): void => {
      if (!isRailInteractionLocked()) {
        onRequestDeleteConversation(item.id);
      }
    };
    const handleOpenConversationWindow = (): void => {
      if (!isRailInteractionLocked()) {
        onOpenConversationWindow?.(item.id);
      }
    };
    const canMarkUnread = Boolean(
      !previewMode &&
      !item.hasUnreadCompletion &&
      item.isImported !== true &&
      (item.unreadCompletionKey ||
        item.status === "completed" ||
        item.status === "ready")
    );
    const menu = useConversationActionGroups({
      canMarkUnread,
      conversation: item,
      isInteractionLocked: isRailInteractionLocked,
      labels,
      uiLanguage,
      workspaceId,
      onMarkConversationUnread,
      onOpenConversationWindow,
      onRequestRenameConversation
    });
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
            {conversationIcon?.kind === "mask" ? (
              <span
                aria-hidden="true"
                className={cn(
                  styles.conversationProviderIcon,
                  styles.conversationProviderMaskIcon
                )}
                style={{
                  WebkitMaskImage: `url("${conversationIcon.url}")`,
                  maskImage: `url("${conversationIcon.url}")`
                }}
              />
            ) : conversationIcon ? (
              <img
                alt=""
                aria-hidden="true"
                className={cn(
                  styles.conversationProviderIcon,
                  styles.conversationProviderImage
                )}
                draggable={false}
                src={conversationIcon.url}
              />
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
                <AgentGUIConversationActionsDropdown
                  buttonClassName={styles.conversationMoreButton}
                  menu={menu}
                  moreSessionActionsLabel={labels.moreSessionActions}
                />
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
      <AgentGUIConversationActionsContextMenu menu={menu}>
        {row}
      </AgentGUIConversationActionsContextMenu>
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
      createAgentGUIUserProjectSelectionApi({
        selectProjectDirectory,
        userProjects: agentHostApi.userProjects
      }),
    [agentHostApi.userProjects, selectProjectDirectory]
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
