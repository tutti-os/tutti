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
import { ConfirmationDialog } from "@tutti-os/ui-system";
import { ScrollArea } from "@tutti-os/ui-system/components";
import { CreateChatIcon } from "@tutti-os/ui-system/icons";
import { Button } from "../../../app/renderer/components/ui/button";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { TaskSearchField } from "../../RoomIssueNode/TaskSearchField";
import { AgentConversationListSkeleton } from "../AgentConversationListSkeleton";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import {
  groupConversations,
  type ConversationSection
} from "../agentGuiNodeViewConversation";
import {
  normalizeConversationRailProjectPath,
  stabilizeConversationSections
} from "./agentGUIConversationRailData";
import { useAgentGUIConversationRail } from "./useAgentGUIConversationRail";
import { AgentGUIConversationRailSection } from "./AgentGUIConversationRailSection";
import { AgentGUIProjectRailHeader } from "./AgentGUIConversationRailItem";
import {
  agentGuiPerfNowMs,
  conversationPlainTitle,
  roundAgentGuiPerfMs
} from "./agentGUIViewUtils";
import styles from "../AgentGUINode.styles";

const AGENT_GUI_CONVERSATION_RAIL_LOADING_SKELETON_DELAY_MS = 300;
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

export interface AgentGUIConversationRailPaneProps {
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  footer?: React.ReactNode;
  workspaceId: string;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
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
  onConfirmDeleteProjectConversations: (path?: string) => void;
  onConfirmDeleteConversations: (agentSessionIds: string[]) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (agentSessionId: string) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
}

export type AgentGUIProjectActionDialog =
  | {
      kind: "batch-delete";
      conversationCount: number;
      label: string;
      path: string;
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
  AgentGUIConversationRailPaneProps,
  "conversations" | "userProjects" | "workspaceId"
>;

export type AgentGUIConversationRailState = Omit<
  AgentGUIConversationRailPaneProps,
  keyof AgentGUIConversationRailDataProps
>;

export const AgentGUIConversationRailPane = memo(
  function AgentGUIConversationRailPane({
    conversations,
    footer,
    workspaceId,
    userProjects,
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
    onConfirmDeleteConversation
  }: AgentGUIConversationRailPaneProps): React.JSX.Element {
    "use memo";
    const [conversationQuery, setConversationQuery] = useState("");
    const [collapsedProjectSectionIds, setCollapsedProjectSectionIds] =
      useState<ReadonlySet<string>>(() => new Set());
    const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
    const [pendingProjectAction, setPendingProjectAction] =
      useState<AgentGUIProjectActionDialog | null>(null);
    const railElementRef = useRef<HTMLElement | null>(null);
    const conversationListRef = useRef<HTMLDivElement | null>(null);
    const conversationItemElementsRef = useRef(
      new Map<string, HTMLDivElement>()
    );
    const activeConversationScrollCompletedRef = useRef<string | null>(null);
    const previousActiveConversationIdRef = useRef<string | null>(null);
    const groupedConversationsRef = useRef<ConversationSection[] | null>(null);
    const {
      loadMoreSectionConversations,
      runtimeSectionsEnabled,
      runtimeRailSections,
      runtimeRailSectionsPending,
      sectionPageStates
    } = useAgentGUIConversationRail({
      conversationFilter,
      conversationQuery,
      conversations,
      labels,
      previewMode,
      sectionAgentTargetFallbackId,
      userProjects,
      workspaceId
    });

    useEffect(() => {
      // timing: refresh relative timestamps in the rail once a minute
      const timer = window.setInterval(() => {
        setCurrentTimeMs(Date.now());
      }, 60_000);
      return () => {
        window.clearInterval(timer);
      };
    }, []);

    const displayConversations = useMemo(
      () =>
        runtimeSectionsEnabled
          ? (runtimeRailSections?.flatMap((section) => section.items) ?? [])
          : runtimeRailSections
            ? runtimeRailSections.flatMap((section) => section.items)
            : conversations,
      [conversations, runtimeRailSections, runtimeSectionsEnabled]
    );

    const filteredConversationResult = useMemo(() => {
      const startedAtMs = agentGuiPerfNowMs();
      const query = conversationQuery.trim().toLowerCase();
      const items = !query
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
    }, [conversationQuery, displayConversations, labels, uiLanguage]);
    const filteredConversations = filteredConversationResult.items;
    const groupedConversationResult = useMemo(() => {
      const startedAtMs = agentGuiPerfNowMs();
      const query = conversationQuery.trim();
      const rawGroups =
        runtimeSectionsEnabled || runtimeRailSections
          ? runtimeRailSections
            ? !query
              ? runtimeRailSections
              : runtimeRailSections
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
                      section.kind !== "pinned" || section.items.length > 0
                  )
            : []
          : groupConversations(filteredConversations, labels, userProjects, {
              includeEmptyConversations: !query
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
      filteredConversations,
      labels,
      runtimeRailSections,
      runtimeSectionsEnabled,
      userProjects
    ]);
    const groupedConversations = groupedConversationResult.groups;
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
        groupedConversations
          .map(
            (section) =>
              `${section.id}:${section.items.map((item) => item.id).join(",")}`
          )
          .join("|"),
      [groupedConversations]
    );
    const projectConversationCountsByPath = useMemo(() => {
      const counts = new Map<string, number>();
      for (const conversation of displayConversations) {
        const normalizedPath = normalizeConversationRailProjectPath(
          conversation.project?.path
        );
        if (!normalizedPath) {
          continue;
        }
        counts.set(normalizedPath, (counts.get(normalizedPath) ?? 0) + 1);
      }
      return counts;
    }, [displayConversations]);
    const isRuntimeRailLoading =
      runtimeSectionsEnabled &&
      (runtimeRailSections === null || runtimeRailSectionsPending);
    const isConversationRailListLoading =
      isRuntimeRailLoading ||
      (isLoadingConversations && conversations.length === 0);
    const shouldShowConversationSkeleton = useDelayedBoolean(
      isConversationRailListLoading,
      AGENT_GUI_CONVERSATION_RAIL_LOADING_SKELETON_DELAY_MS
    );
    const shouldShowConversationEmptyState =
      !isConversationRailListLoading && groupedConversations.length === 0;
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
            onChange={setConversationQuery}
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
          ) : shouldShowConversationEmptyState ? (
            <div className={styles.emptyState}>
              <span>
                {conversations.length === 0
                  ? labels.noConversations
                  : conversationQuery.trim()
                    ? labels.searchNoConversations
                    : labels.conversationUnavailable}
              </span>
            </div>
          ) : (
            groupedConversations.map((section, sectionIndex) => {
              const projectPath =
                section.kind === "project" ? (section.project?.path ?? "") : "";
              const normalizedProjectPath =
                normalizeConversationRailProjectPath(projectPath);
              const projectLabel =
                section.kind === "project" ? section.label : "";
              const isProjectSection = section.kind === "project";
              const showProjectRailHeader =
                !conversationQuery.trim() &&
                section.kind !== "pinned" &&
                (sectionIndex === 0 ||
                  groupedConversations[sectionIndex - 1]?.kind === "pinned");
              const isSectionCollapsed =
                isProjectSection && collapsedProjectSectionIds.has(section.id);
              const projectConversationCount = normalizedProjectPath
                ? (projectConversationCountsByPath.get(normalizedProjectPath) ??
                  0)
                : 0;
              const sectionPageState = sectionPageStates.get(section.id);
              const sectionHasMore =
                !conversationQuery.trim() && sectionPageState?.hasMore === true;
              return (
                <Fragment key={section.id}>
                  {showProjectRailHeader ? (
                    <AgentGUIProjectRailHeader
                      labels={labels}
                      selectProjectDirectory={selectProjectDirectory}
                      workspaceUserProjectI18n={workspaceUserProjectI18n}
                    />
                  ) : null}
                  <AgentGUIConversationRailSection
                    activeConversationId={activeConversationId}
                    createConversationDisabled={createConversationDisabled}
                    currentTimeMs={currentTimeMs}
                    isDeletingConversation={isDeletingConversation}
                    isLoadingMoreConversations={
                      sectionPageState?.isLoading ?? false
                    }
                    isSectionCollapsed={isSectionCollapsed}
                    labels={labels}
                    pendingDeleteConversationId={pendingDeleteConversationId}
                    previewMode={previewMode}
                    projectConversationCount={projectConversationCount}
                    projectLabel={projectLabel}
                    projectPath={projectPath}
                    registerItemElement={registerConversationItemElement}
                    section={section}
                    sectionHasMore={sectionHasMore}
                    uiLanguage={uiLanguage}
                    workspaceId={workspaceId}
                    onCancelDeleteConversation={onCancelDeleteConversation}
                    onConfirmDeleteConversation={onConfirmDeleteConversation}
                    onCreateConversation={onCreateConversation}
                    onLoadMoreConversations={loadMoreSectionConversations}
                    onRequestDeleteConversation={onRequestDeleteConversation}
                    onRequestRenameConversation={onRequestRenameConversation}
                    onSelectConversation={onSelectConversation}
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
            })
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
            const action = pendingProjectAction;
            setPendingProjectAction(null);
            if (!action) {
              return;
            }
            if (action.kind === "batch-delete") {
              onConfirmDeleteProjectConversations(action.path);
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
