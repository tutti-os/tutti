import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type * as React from "react";
import {
  AgentInteractivePromptSurface,
  buildWorkspaceAgentInteractivePromptLabels,
  buildWorkspaceAgentMessageCenterModel,
  isWaitingMessageCenterItem,
  WorkspaceAgentMessageCenterPanel,
  type WorkspaceAgentMessageCenterItem
} from "@tutti-os/agent-gui/agent-message-center";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import type {
  WorkbenchHostChromeRenderContext,
  WorkbenchController,
  WorkbenchHostNodeData,
  WorkbenchMissionControlMode
} from "@tutti-os/workbench-surface";
import {
  AppWindowIcon,
  Button,
  CloseIcon,
  OverviewLayoutIcon,
  SettingsIcon,
  ShortcutBadge,
  StatusDot,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { INotificationService } from "@tutti-os/ui-notifications";
import type { CompositeNotificationMessage } from "@renderer/lib/compositeNotificationService";
import { useService } from "@tutti-os/infra/di";
import { MessageCenterOpenedReporter } from "@renderer/features/analytics/reporters/message-center-opened/messageCenterOpenedReporter.ts";
import { MessageCenterNotificationActionedReporter } from "@renderer/features/analytics/reporters/message-center-notification-actioned/messageCenterNotificationActionedReporter.ts";
import { IReporterService } from "@renderer/features/analytics";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { WorkspaceSettingsPanel } from "./WorkspaceSettingsPanel";
import { useWorkspaceChromeState } from "./useWorkspaceChromeState";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import {
  buildWorkspaceAgentDecisionNotification,
  type WorkspaceAgentDecisionSubmitInput
} from "../services/workspaceAgentDecisionNotification";
import {
  buildWorkspaceAgentOutcomeNotification,
  workspaceAgentOutcomeNotificationKey
} from "../services/workspaceAgentOutcomeNotification";
import { resolveWorkspaceAgentMessageCenterTrigger } from "../services/workspaceAgentMessageCenterTrigger";
import { toggleWorkspaceAgentMessageCenter } from "../services/workspaceAgentMessageCenterToggle";
import { createWorkspaceAgentGuiSessionLaunchRequest } from "../services/workspaceAgentGuiLaunch";
import { requestWorkspaceBrowserLaunch } from "../services/workspaceBrowserLaunchCoordinator";
import { requestWorkspaceFilesLaunch } from "../services/workspaceFilesLaunchCoordinator";
import { requestWorkspaceIssueManagerLaunch } from "../services/workspaceIssueManagerLaunchCoordinator";
import {
  resolveWorkspaceAgentStatusPetMood,
  type WorkspaceAgentStatusPetMood
} from "../services/workspaceAgentStatusPetMood";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "../services/workspaceWallpaper";

const MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT = 20;
const WORKSPACE_AGENT_DECISION_TOAST_DURATION = Infinity;
const workspaceAgentDecisionToastClassName = "workspace-agent-decision-toast";
const AGENT_STATUS_PET_SOURCES = {
  failed: new URL(
    "../../../assets/agent-status-pet/failed.gif",
    import.meta.url
  ).href,
  idle: new URL("../../../assets/agent-status-pet/idle.gif", import.meta.url)
    .href,
  review: new URL(
    "../../../assets/agent-status-pet/review.gif",
    import.meta.url
  ).href,
  running: new URL(
    "../../../assets/agent-status-pet/running.gif",
    import.meta.url
  ).href,
  waiting: new URL(
    "../../../assets/agent-status-pet/waiting.gif",
    import.meta.url
  ).href,
  waving: new URL(
    "../../../assets/agent-status-pet/waving.gif",
    import.meta.url
  ).href
} as const;

type AgentStatusPetMood = WorkspaceAgentStatusPetMood &
  keyof typeof AGENT_STATUS_PET_SOURCES;

export function WorkspaceChrome({
  headerSlot,
  missionControl,
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  platform,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  wallpaperAppearance,
  launchNode,
  workbenchController,
  workspace
}: {
  headerSlot?: React.ReactNode;
  missionControl: {
    canOpen: boolean;
    close(): void;
    isOpen: boolean;
    mode: WorkbenchMissionControlMode | null;
    open(
      mode: WorkbenchMissionControlMode,
      trigger?: "button" | "keyboard"
    ): void;
    visibleWindowCount: number;
  };
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  platform: NodeJS.Platform;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  wallpaperAppearance: "dark" | "light";
  launchNode?: WorkbenchHostChromeRenderContext["launchNode"];
  workbenchController?: WorkbenchController<WorkbenchHostNodeData>;
  workspace: WorkspaceSummary;
}) {
  const isDarwin = platform === "darwin";
  const isWindows = platform === "win32";
  const chromeState = useWorkspaceChromeState({
    platform,
    workbenchController
  });
  const headerStyle = isDarwin
    ? ({
        "--workspace-chrome-left-padding": chromeState.useCompactTitlebar
          ? "12px"
          : "calc(12px + var(--cove-workspace-mac-traffic-light-gutter, 68px))"
      } as React.CSSProperties)
    : undefined;

  return (
    <header
      className={cn(
        "grid min-h-[52px] items-center gap-4 bg-transparent px-4 [-webkit-app-region:drag]",
        "grid-cols-[max-content_minmax(0,1fr)_max-content]",
        isDarwin && "pl-[var(--workspace-chrome-left-padding)]",
        isWindows &&
          "pr-[calc(100vw-env(titlebar-area-width,calc(100vw-138px))+10px)]"
      )}
      data-app-header="true"
      style={headerStyle}
    >
      <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
        {isDarwin && !chromeState.useCompactTitlebar ? (
          <div
            aria-hidden="true"
            className="h-full w-[88px] shrink-0 [-webkit-app-region:no-drag]"
          />
        ) : null}
      </div>
      <div aria-hidden="true" className="min-w-0" />
      <div
        className="flex items-center justify-end gap-2 justify-self-end [-webkit-app-region:no-drag]"
        data-workbench-wallpaper-appearance={wallpaperAppearance}
      >
        {headerSlot ? (
          <div className="min-w-0 translate-y-1">{headerSlot}</div>
        ) : null}
        <WorkspaceAgentMessageCenterAction
          launchNode={launchNode}
          workspace={workspace}
        />
        <WorkspaceMissionControlActions
          missionControl={missionControl}
          platform={platform}
        />
        <WorkspaceSettingsTrigger
          onSelectWallpaper={onSelectWallpaper}
          onSelectWallpaperDisplayMode={onSelectWallpaperDisplayMode}
          selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
          selectedWallpaperID={selectedWallpaperID}
          workspace={workspace}
        />
      </div>
    </header>
  );
}

function WorkspaceAgentMessageCenterAction({
  launchNode,
  workspace
}: {
  launchNode?: WorkbenchHostChromeRenderContext["launchNode"];
  workspace: WorkspaceSummary;
}) {
  const { i18n, locale, t } = useTranslation();
  const workspaceAgentActivityService = useService(
    IWorkspaceAgentActivityService
  );
  const reporterService = useService(IReporterService);
  const notifications = useService(INotificationService);
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const [open, setOpen] = useState(false);
  const [highlightedMessageCenterItemId, setHighlightedMessageCenterItemId] =
    useState<string | null>(null);
  const snapshotRef = useRef<{
    snapshot: AgentActivitySnapshot;
    workspaceId: string;
  } | null>(null);
  const requestedMessageSummarySessionIdsRef = useRef<Set<string>>(new Set());
  const seenWaitingNotificationKeysRef = useRef<Set<string> | null>(null);
  const seenOutcomeNotificationKeysRef = useRef<Set<string> | null>(null);
  const activeWaitingNotificationToastIdsRef = useRef<Map<string, string>>(
    new Map()
  );
  const snapshot = useSyncExternalStore(
    (listener) =>
      workspaceAgentActivityService.subscribe(workspace.id, (nextSnapshot) => {
        snapshotRef.current = {
          snapshot: nextSnapshot,
          workspaceId: workspace.id
        };
        listener();
      }),
    () => {
      if (snapshotRef.current?.workspaceId === workspace.id) {
        return snapshotRef.current.snapshot;
      }
      const nextSnapshot = workspaceAgentActivityService.getSnapshot(
        workspace.id
      );
      snapshotRef.current = {
        snapshot: nextSnapshot,
        workspaceId: workspace.id
      };
      return nextSnapshot;
    },
    () => {
      if (snapshotRef.current?.workspaceId === workspace.id) {
        return snapshotRef.current.snapshot;
      }
      const nextSnapshot = workspaceAgentActivityService.getSnapshot(
        workspace.id
      );
      snapshotRef.current = {
        snapshot: nextSnapshot,
        workspaceId: workspace.id
      };
      return nextSnapshot;
    }
  );
  const model = useMemo(
    () =>
      buildWorkspaceAgentMessageCenterModel(snapshot, {
        promptFallbackLabels: {
          constraintHeader: t(
            "workspace.agentMessageCenter.promptConstraintHeader"
          ),
          inputHeader: t("workspace.agentMessageCenter.promptInputHeader"),
          question: t("workspace.agentMessageCenter.promptQuestion"),
          title: t("workspace.agentMessageCenter.promptTitle")
        },
        workspaceRoot: null
      }),
    [snapshot, t]
  );
  const waitingItems = useMemo(
    () => model.items.filter(isWaitingMessageCenterItem),
    [model.items]
  );
  const triggerPetMood = useMemo(
    () => resolveWorkspaceAgentStatusPetMood(snapshot, model.waitingCount),
    [snapshot, model.waitingCount]
  );
  const trigger = useMemo(
    () =>
      resolveWorkspaceAgentMessageCenterTrigger({
        runningCount: model.counts.working,
        waitingCount: model.waitingCount
      }),
    [model.counts.working, model.waitingCount]
  );
  const triggerLabel = t(trigger.translationKey, {
    count: trigger.count
  });
  useEffect(() => {
    void workspaceAgentActivityService.load(workspace.id);
  }, [workspace.id, workspaceAgentActivityService]);

  useEffect(() => {
    requestedMessageSummarySessionIdsRef.current.clear();
    seenWaitingNotificationKeysRef.current = null;
    seenOutcomeNotificationKeysRef.current = null;
    for (const toastId of activeWaitingNotificationToastIdsRef.current.values()) {
      toast.dismiss(toastId);
    }
    activeWaitingNotificationToastIdsRef.current.clear();
    setHighlightedMessageCenterItemId(null);
  }, [workspace.id]);

  useEffect(() => {
    const outcomeEntries = model.items
      .map(
        (item) => [workspaceAgentOutcomeNotificationKey(item), item] as const
      )
      .filter(
        (entry): entry is readonly [string, WorkspaceAgentMessageCenterItem] =>
          entry[0] !== null
      );
    const currentKeys = new Set(outcomeEntries.map(([key]) => key));
    const seenKeys = seenOutcomeNotificationKeysRef.current;
    if (!seenKeys) {
      seenOutcomeNotificationKeysRef.current = currentKeys;
      return;
    }
    const nextSeenKeys = new Set(seenKeys);
    for (const key of currentKeys) {
      nextSeenKeys.add(key);
    }
    seenOutcomeNotificationKeysRef.current = nextSeenKeys;
    for (const [notificationKey, item] of outcomeEntries) {
      if (seenKeys.has(notificationKey)) {
        continue;
      }
      const notification = buildWorkspaceAgentOutcomeNotification(item, {
        completedBody: t(
          "workspace.agentMessageCenter.outcomeNotificationCompletedBody"
        ),
        failedBody: t(
          "workspace.agentMessageCenter.outcomeNotificationFailedBody"
        ),
        fallbackAgentName: t("workspace.agentGui.fallbackAgentLabel")
      });
      if (!notification) {
        continue;
      }
      const message: CompositeNotificationMessage = {
        description: notification.body,
        level: notification.level,
        navigation: {
          agentSessionId: notification.agentSessionId,
          provider: item.provider,
          workspaceId: workspace.id
        },
        // The message center panel and trigger badge already surface
        // outcomes in-app; only the OS face should notify, and only while
        // the window is in the background (composite checks visibility).
        presentation: "background-only",
        title: t(
          notification.level === "success"
            ? "workspace.agentMessageCenter.outcomeNotificationCompletedTitle"
            : "workspace.agentMessageCenter.outcomeNotificationFailedTitle",
          {
            title: notification.conversationTitle || notification.agentName
          }
        )
      };
      notifications.notify(message);
    }
  }, [model, notifications, t]);

  useEffect(() => {
    const waitingEntries = waitingItems.map(
      (item) => [waitingNotificationKey(item), item] as const
    );
    const currentKeys = new Set(waitingEntries.map(([key]) => key));
    for (const [
      notificationKey,
      toastId
    ] of activeWaitingNotificationToastIdsRef.current) {
      if (!currentKeys.has(notificationKey)) {
        toast.dismiss(toastId);
        activeWaitingNotificationToastIdsRef.current.delete(notificationKey);
      }
    }
    const seenKeys = seenWaitingNotificationKeysRef.current;
    if (!seenKeys) {
      seenWaitingNotificationKeysRef.current = currentKeys;
      return;
    }
    const nextSeenKeys = new Set(seenKeys);
    for (const key of currentKeys) {
      nextSeenKeys.add(key);
    }
    seenWaitingNotificationKeysRef.current = nextSeenKeys;
    const newWaitingEntries = waitingEntries.filter(
      ([key]) => !seenKeys.has(key)
    );
    for (const [notificationKey, item] of newWaitingEntries) {
      const notification = buildWorkspaceAgentDecisionNotification(item, {
        commandLabel: t(
          "workspace.agentMessageCenter.waitingNotificationCommand"
        ),
        fallbackAgentName: t("workspace.agentGui.fallbackAgentLabel"),
        planModes: [
          {
            id: "acceptEdits",
            label: t(
              "workspace.agentMessageCenter.waitingNotificationPlanAcceptEdits"
            )
          },
          {
            id: "default",
            label: t(
              "workspace.agentMessageCenter.waitingNotificationPlanAskFirst"
            )
          },
          {
            id: "bypassPermissions",
            label: t(
              "workspace.agentMessageCenter.waitingNotificationPlanAllowAll"
            )
          }
        ]
      });
      if (!notification || notification.options.length === 0) {
        continue;
      }
      const osMessage: CompositeNotificationMessage = {
        description: notification.description,
        level: "warning",
        navigation: {
          agentSessionId: item.agentSessionId,
          provider: item.provider,
          workspaceId: workspace.id
        },
        // The decision toast below already covers the in-app face; only
        // raise the OS notification while the window is in the background.
        presentation: "background-only",
        title: t("workspace.agentMessageCenter.waitingNotificationTitle", {
          title: notification.conversationTitle || notification.agentName
        })
      };
      notifications.notify(osMessage);
      if (open) {
        continue;
      }
      const toastId = `workspace-agent-waiting:${workspace.id}:${notificationKey}`;
      activeWaitingNotificationToastIdsRef.current.set(
        notificationKey,
        toastId
      );
      toast.custom(
        (id) => (
          <WorkspaceAgentDecisionToast
            agentIconUrl={notification.agentIconUrl}
            agentName={notification.agentName}
            closeLabel={t("common.close")}
            conversationTitle={notification.conversationTitle}
            prompt={notification.prompt}
            promptLabels={buildWorkspaceAgentInteractivePromptLabels(
              t as unknown as Parameters<
                typeof buildWorkspaceAgentInteractivePromptLabels
              >[0],
              item.provider
            )}
            waitingStatusLabel={t(
              "workspace.agentMessageCenter.waitingNotificationStatus"
            )}
            onClose={() => {
              activeWaitingNotificationToastIdsRef.current.delete(
                notificationKey
              );
              toast.dismiss(id);
            }}
            onSubmit={async (input) => {
              await workspaceAgentActivityService.submitInteractive({
                workspaceId: workspace.id,
                agentSessionId: item.agentSessionId,
                requestId: input.requestId,
                action: input.action ?? null,
                optionId: input.optionId ?? null,
                payload: input.payload ?? null
              });
              activeWaitingNotificationToastIdsRef.current.delete(
                notificationKey
              );
              toast.dismiss(id);
            }}
          />
        ),
        {
          className: workspaceAgentDecisionToastClassName,
          id: toastId,
          duration: WORKSPACE_AGENT_DECISION_TOAST_DURATION
        }
      );
    }
  }, [
    notifications,
    open,
    t,
    waitingItems,
    workspace.id,
    workspaceAgentActivityService
  ]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const abortController = new AbortController();
    const targets = snapshot.sessions.filter((session) => {
      const agentSessionId = session.agentSessionId.trim();
      if (!agentSessionId) {
        return false;
      }
      if (requestedMessageSummarySessionIdsRef.current.has(agentSessionId)) {
        return false;
      }
      return !hasCachedWorkspaceAgentSessionMessages(
        snapshot.sessionMessagesById,
        session
      );
    });
    if (targets.length === 0) {
      return () => {
        abortController.abort();
      };
    }
    for (const session of targets) {
      requestedMessageSummarySessionIdsRef.current.add(
        session.agentSessionId.trim()
      );
    }
    void Promise.all(
      targets.map(async (session) => {
        try {
          await workspaceAgentActivityService.listSessionMessages({
            workspaceId: workspace.id,
            agentSessionId: session.agentSessionId,
            limit: MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT,
            order: "desc",
            signal: abortController.signal
          });
        } catch {
          requestedMessageSummarySessionIdsRef.current.delete(
            session.agentSessionId.trim()
          );
        }
      })
    );
    return () => {
      abortController.abort();
    };
  }, [open, snapshot, workspace.id, workspaceAgentActivityService]);

  const openMessageCenterChat = useCallback(
    (input: { agentSessionId: string; provider: string }) => {
      const launchPromise = launchNode?.(
        createWorkspaceAgentGuiSessionLaunchRequest({
          agentSessionId: input.agentSessionId,
          provider: input.provider
        })
      );
      if (!launchPromise) {
        setOpen(false);
        return;
      }
      void launchPromise.finally(() => {
        setOpen(false);
      });
    },
    [launchNode]
  );
  useEffect(
    () =>
      workbenchHostService.onNotificationNavigate((payload) => {
        if (payload.workspaceId !== workspace.id) {
          return;
        }
        openMessageCenterChat({
          agentSessionId: payload.agentSessionId,
          provider: payload.provider
        });
      }),
    [openMessageCenterChat, workbenchHostService, workspace.id]
  );
  const handleLinkAction = useCallback(
    (action: Parameters<typeof runDesktopAgentGUILinkAction>[0]) => {
      void runDesktopAgentGUILinkAction(action, {
        homeDirectory: workbenchHostService.getHomeDirectory(),
        launchAgentGui: async (input) => {
          const nodeId = await launchNode?.(
            createWorkspaceAgentGuiSessionLaunchRequest({
              agentSessionId: input.agentSessionId,
              provider: input.provider
            })
          );
          return Boolean(nodeId);
        },
        launchWorkspaceIssueManager: requestWorkspaceIssueManagerLaunch,
        launchWorkspaceFiles: requestWorkspaceFilesLaunch,
        openBrowserUrl: requestWorkspaceBrowserLaunch,
        workspaceId: workspace.id
      });
    },
    [launchNode, workbenchHostService, workspace.id]
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label={t("workspace.agentMessageCenter.openAria")}
            className="inline-flex"
          >
            <Button
              aria-expanded={open}
              aria-label={t("workspace.agentMessageCenter.openAria")}
              className={cn(
                "gap-1.5 rounded-[6px] border-transparent bg-transparent px-2.5 text-[var(--workbench-chrome-foreground)] shadow-none hover:border-transparent hover:bg-transparent focus-visible:border-transparent focus-visible:bg-transparent active:bg-transparent aria-expanded:bg-transparent",
                open && "text-foreground"
              )}
              size="sm"
              title={triggerLabel}
              type="button"
              variant="ghost"
              onClick={() =>
                toggleWorkspaceAgentMessageCenter({
                  onOpened: () => {
                    void new MessageCenterOpenedReporter(
                      {
                        unreadCount: model.waitingCount
                      },
                      {
                        reporterService
                      }
                    ).report();
                  },
                  open,
                  setOpen
                })
              }
            >
              <AgentStatusPetIcon mood={triggerPetMood} />
              <span className="text-[13px] font-semibold">{triggerLabel}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {t("workspace.agentMessageCenter.title")}
        </TooltipContent>
      </Tooltip>
      <WorkspaceAgentMessageCenterPanel
        i18n={i18n}
        locale={locale}
        open={open}
        model={model}
        highlightedItemId={highlightedMessageCenterItemId}
        onClose={() => setOpen(false)}
        onHighlightedItemSettled={(itemId) => {
          setHighlightedMessageCenterItemId((current) =>
            current === itemId ? null : current
          );
        }}
        onLinkAction={handleLinkAction}
        onNotificationActioned={(input) => {
          void new MessageCenterNotificationActionedReporter(
            {
              action: input.action,
              provider: input.provider
            },
            {
              reporterService
            }
          ).report();
        }}
        onOpenChat={openMessageCenterChat}
        onSubmitPrompt={async (input) => {
          await workspaceAgentActivityService.submitPlanDecision({
            workspaceId: workspace.id,
            agentSessionId: input.agentSessionId,
            // "" (no pending-prompt kind) takes the interactive-prompt branch
            // in planDecisionOps; only "plan-implementation" diverges from it.
            promptKind: input.promptKind ?? "",
            requestId: input.requestId,
            ...(input.action ? { action: input.action } : {}),
            ...(input.optionId ? { optionId: input.optionId } : {}),
            ...(input.payload ? { payload: input.payload } : {})
          });
        }}
      />
    </>
  );
}

function WorkspaceAgentDecisionToast({
  agentIconUrl,
  agentName,
  closeLabel,
  conversationTitle,
  prompt,
  promptLabels,
  waitingStatusLabel,
  onClose,
  onSubmit
}: {
  agentIconUrl: string;
  agentName: string;
  closeLabel: string;
  conversationTitle: string;
  prompt: NonNullable<WorkspaceAgentMessageCenterItem["pendingPrompt"]>;
  promptLabels: ReturnType<typeof buildWorkspaceAgentInteractivePromptLabels>;
  waitingStatusLabel: string;
  onClose: () => void;
  onSubmit: (input: WorkspaceAgentDecisionSubmitInput) => Promise<void>;
}) {
  "use memo";
  const [isSubmitting, setIsSubmitting] = useState(false);
  const displayTitle = conversationTitle || agentName;

  return (
    <article className="relative w-full min-w-0 overflow-visible rounded-[12px] border border-[var(--tutti-purple-border)] bg-[var(--tutti-purple-bg)] p-3.5">
      <span
        aria-hidden="true"
        className="workspace-agent-decision-toast__edge-glow agent-gui-edge-glow pointer-events-none inset-0 rounded-[12px]"
        style={{ position: "absolute" }}
      />
      <button
        type="button"
        aria-label={closeLabel}
        className="workspace-agent-decision-toast__close absolute top-0 right-0 z-[2] inline-flex size-6 translate-x-[35%] -translate-y-[35%] items-center justify-center rounded-full border border-[var(--line-2)] bg-[var(--background-panel)] text-[var(--text-secondary)] shadow-sm transition-colors hover:bg-[var(--background-fronted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--border-focus)_30%,transparent)]"
        onClick={onClose}
      >
        <CloseIcon className="size-4" />
      </button>
      <div className="workspace-agent-decision-toast__content relative z-[1] grid min-w-0 gap-2.5 transition-opacity">
        <div className="flex min-w-0 items-center justify-between gap-2.5 pr-2">
          <h3 className="min-w-0 truncate text-[13px] font-bold leading-5 text-[var(--text-secondary)]">
            {displayTitle}
          </h3>
          <span
            className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold leading-4 text-[var(--text-secondary)]"
            data-status="waiting"
            title={waitingStatusLabel}
          >
            <StatusDot
              tone="amber"
              pulse
              size="sm"
              title={waitingStatusLabel}
            />
            <span>{waitingStatusLabel}</span>
          </span>
        </div>
        <div className="workspace-agent-decision-toast__prompt min-w-0">
          <AgentInteractivePromptSurface
            embedded
            keyboardShortcuts={false}
            prompt={prompt}
            isSubmitting={isSubmitting}
            labels={promptLabels}
            onSubmit={(input) => {
              setIsSubmitting(true);
              void onSubmit(input).catch(() => {
                setIsSubmitting(false);
              });
            }}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-normal leading-5 text-[var(--text-secondary)]">
          <span className="inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--line-1)] bg-[var(--transparency-block)]">
            <img
              src={agentIconUrl}
              alt={agentName}
              className="size-full object-cover"
              decoding="async"
              draggable={false}
            />
          </span>
          <span className="min-w-0 truncate">{agentName}</span>
        </div>
      </div>
    </article>
  );
}

function waitingNotificationKey(item: WorkspaceAgentMessageCenterItem): string {
  const requestId = item.pendingPrompt?.requestId.trim();
  if (requestId) {
    return `${item.agentSessionId}:prompt:${requestId}`;
  }
  return [
    item.agentSessionId,
    "attention",
    item.needsAttentionKind ?? "waiting",
    item.sortTimeUnixMs
  ].join(":");
}

function AgentStatusPetIcon({ mood }: { mood: AgentStatusPetMood }) {
  return (
    <span
      aria-hidden="true"
      className="relative -my-1 grid size-7 shrink-0 place-items-center overflow-visible"
      data-agent-status-pet-mood={mood}
    >
      <img
        alt=""
        className="size-7 object-contain"
        draggable={false}
        src={AGENT_STATUS_PET_SOURCES[mood]}
      />
    </span>
  );
}

function hasCachedWorkspaceAgentSessionMessages(
  sessionMessagesById: AgentActivitySnapshot["sessionMessagesById"],
  session: AgentActivitySnapshot["sessions"][number]
): boolean {
  return workspaceAgentSessionMessageAliases(session).some(
    (alias) => (sessionMessagesById[alias]?.length ?? 0) > 0
  );
}

function workspaceAgentSessionMessageAliases(
  session: AgentActivitySnapshot["sessions"][number]
): string[] {
  return [
    session.agentSessionId,
    session.providerSessionId ?? "",
    session.agentSessionId.trim(),
    (session.providerSessionId ?? "").trim()
  ].filter((alias, index, aliases) => {
    const normalized = alias.trim();
    return normalized.length > 0 && aliases.indexOf(alias) === index;
  });
}

function WorkspaceMissionControlActions({
  missionControl,
  platform
}: {
  missionControl: {
    canOpen: boolean;
    close(): void;
    isOpen: boolean;
    mode: WorkbenchMissionControlMode | null;
    open(
      mode: WorkbenchMissionControlMode,
      trigger?: "button" | "keyboard"
    ): void;
    visibleWindowCount: number;
  };
  platform: NodeJS.Platform;
}) {
  const { t } = useTranslation();
  const isDarwin = platform === "darwin";

  return (
    <div className="flex items-center gap-1">
      <WorkspaceMissionControlAction
        active={missionControl.isOpen && missionControl.mode === "activate"}
        disabled={!missionControl.canOpen}
        label={t("workspace.workbenchDesktop.missionControl.activateTrigger")}
        shortcutLabel={t(
          isDarwin
            ? "workspace.workbenchDesktop.missionControl.activateShortcutMac"
            : "workspace.workbenchDesktop.missionControl.activateShortcutDefault"
        )}
        unavailableLabel={t(
          "workspace.workbenchDesktop.missionControl.unavailableTrigger"
        )}
        onClick={() => {
          if (missionControl.isOpen && missionControl.mode === "activate") {
            missionControl.close();
            return;
          }
          missionControl.open("activate", "button");
        }}
      >
        <OverviewLayoutIcon className="size-4" />
      </WorkspaceMissionControlAction>
      <WorkspaceMissionControlAction
        active={missionControl.isOpen && missionControl.mode === "layout"}
        disabled={!missionControl.canOpen}
        label={t("workspace.workbenchDesktop.missionControl.layoutTrigger")}
        shortcutLabel={t(
          isDarwin
            ? "workspace.workbenchDesktop.missionControl.layoutShortcutMac"
            : "workspace.workbenchDesktop.missionControl.layoutShortcutDefault"
        )}
        unavailableLabel={t(
          "workspace.workbenchDesktop.missionControl.unavailableTrigger"
        )}
        onClick={() => {
          if (missionControl.isOpen && missionControl.mode === "layout") {
            missionControl.close();
            return;
          }
          missionControl.open("layout", "button");
        }}
      >
        <AppWindowIcon className="size-4" />
      </WorkspaceMissionControlAction>
    </div>
  );
}

function WorkspaceMissionControlAction({
  active,
  children,
  disabled,
  label,
  onClick,
  shortcutLabel,
  unavailableLabel
}: {
  active: boolean;
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  shortcutLabel: string;
  unavailableLabel: string;
}) {
  const button = (
    <Button
      aria-label={label}
      className={cn(
        "text-[var(--workbench-chrome-foreground)]",
        active && "bg-transparency-block text-foreground"
      )}
      disabled={disabled}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
      onClick={onClick}
    >
      {children}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={disabled ? unavailableLabel : label}
          className={cn("inline-flex", disabled && "cursor-not-allowed")}
          tabIndex={disabled ? 0 : undefined}
        >
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {disabled ? (
          unavailableLabel
        ) : (
          <>
            <span>{label}</span>
            <ShortcutBadge>{shortcutLabel}</ShortcutBadge>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function WorkspaceSettingsTrigger({
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  workspace
}: {
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  workspace: WorkspaceSummary;
}) {
  const { t } = useTranslation();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const { service: settingsService, state: settingsState } =
    useWorkspaceSettingsService();

  useEffect(() => {
    return workbenchHostService.onOpenSettingsRequest((request) => {
      settingsService.openPanel(
        { id: workspace.id },
        {
          pane: request.pane,
          provider: request.provider,
          section: request.section ?? "general"
        }
      );
    });
  }, [settingsService, workbenchHostService, workspace.id]);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label={t("workspace.settings.trigger")}
            className="inline-flex"
          >
            <Button
              aria-expanded={settingsState.open}
              aria-label={t("workspace.settings.trigger")}
              className={cn(
                "text-[var(--workbench-chrome-foreground)]",
                settingsState.open && "text-foreground"
              )}
              size="icon-sm"
              title={t("workspace.settings.trigger")}
              type="button"
              variant="ghost"
              onClick={() => settingsService.openPanel({ id: workspace.id })}
            >
              <SettingsIcon className="size-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("workspace.settings.trigger")}</TooltipContent>
      </Tooltip>
      <WorkspaceSettingsPanel
        onSelectWallpaper={onSelectWallpaper}
        onSelectWallpaperDisplayMode={onSelectWallpaperDisplayMode}
        selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
        selectedWallpaperID={selectedWallpaperID}
        workspace={workspace}
      />
    </>
  );
}
