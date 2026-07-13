import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentInteractivePromptSurface,
  buildWorkspaceAgentInteractivePromptLabels,
  buildWorkspaceAgentMessageCenterModelFromEngine,
  isWaitingMessageCenterItem,
  selectWorkspaceAgentMessageCenterPresentation,
  stabilizeWorkspaceAgentMessageCenterModel,
  workspaceAgentMessageCenterPromptStatus,
  workspaceAgentMessageCenterPresentationEqual,
  WorkspaceAgentMessageCenterPanel,
  dispatchAgentPlanPromptAction,
  useEngineSelector,
  type WorkspaceAgentMessageCenterItem,
  type WorkspaceAgentMessageCenterModel
} from "@tutti-os/agent-gui/agent-message-center";
import {
  type AgentActivityMessage,
  type CanonicalAgentSession,
  selectEnginePendingInteractions
} from "@tutti-os/agent-activity-core";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import type { WorkbenchHostChromeRenderContext } from "@tutti-os/workbench-surface";
import {
  Button,
  CloseIcon,
  StatusDot,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { INotificationService } from "@tutti-os/ui-notifications";
import {
  createDocumentNotificationVisibilityState,
  type CompositeNotificationMessage
} from "@renderer/lib/compositeNotificationService";
import { useService } from "@tutti-os/infra/di";
import { MessageCenterOpenedReporter } from "@renderer/features/analytics/reporters/message-center-opened/messageCenterOpenedReporter.ts";
import { MessageCenterNotificationActionedReporter } from "@renderer/features/analytics/reporters/message-center-notification-actioned/messageCenterNotificationActionedReporter.ts";
import { IReporterService } from "@renderer/features/analytics";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import {
  buildWorkspaceAgentDecisionNotification,
  type WorkspaceAgentDecisionSubmitInput
} from "../services/workspaceAgentDecisionNotification";
import { shouldShowWorkspaceAgentDecisionToast } from "../services/workspaceAgentDecisionToastVisibility";
import { resolveWorkspaceAgentMessageCenterTrigger } from "../services/workspaceAgentMessageCenterTrigger";
import { toggleWorkspaceAgentMessageCenter } from "../services/workspaceAgentMessageCenterToggle";
import { registerWorkspaceMessageCenterOpenHandler } from "../services/workspaceMessageCenterCoordinator";
import { isWorkspaceAgentGuiSessionOpen } from "../services/workspaceAgentGuiOpenSessionCoordinator";
import { createWorkspaceAgentGuiSessionLaunchRequest } from "../services/workspaceAgentGuiLaunch";
import { requestWorkspaceBrowserLaunch } from "../services/workspaceBrowserLaunchCoordinator";
import { requestWorkspaceFilesLaunch } from "../services/workspaceFilesLaunchCoordinator";
import { requestWorkspaceIssueManagerLaunch } from "../services/workspaceIssueManagerLaunchCoordinator";
import { requestGroupChatLaunch } from "../services/groupChatLaunchCoordinator";
import { resolveWorkspaceAgentStatusPetMood } from "../services/workspaceAgentStatusPetMood";
import { WorkspaceAgentStatusPetIcon } from "./WorkspaceAgentStatusPetIcon";

const MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT = 20;
const MESSAGE_CENTER_SUMMARY_PREFETCH_ITEM_LIMIT = 12;
const MESSAGE_CENTER_VISIBLE_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_AGENT_DECISION_TOAST_DURATION = Infinity;
const workspaceAgentDecisionToastClassName = "workspace-agent-decision-toast";

export function WorkspaceAgentMessageCenterAction({
  launchNode,
  open,
  setOpen,
  workspace
}: {
  launchNode?: WorkbenchHostChromeRenderContext["launchNode"];
  open: boolean;
  setOpen: (nextOpen: boolean) => void;
  workspace: WorkspaceSummary;
}) {
  const { i18n, locale, t } = useTranslation();
  const workspaceAgentActivityService = useService(
    IWorkspaceAgentActivityService
  );
  const reporterService = useService(IReporterService);
  const notifications = useService(INotificationService);
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const windowForegroundVisibility = useMemo(
    () =>
      createDocumentNotificationVisibilityState({
        hasFocus: () => document.hasFocus(),
        visibilityState: () => document.visibilityState
      }),
    []
  );
  const [highlightedMessageCenterItemId, setHighlightedMessageCenterItemId] =
    useState<string | null>(null);
  const [sessionMessagesById, setSessionMessagesById] = useState<
    Record<string, AgentActivityMessage[]>
  >({});
  const requestedMessageSummarySessionIdsRef = useRef<Set<string>>(new Set());
  const seenWaitingNotificationKeysRef = useRef<Set<string> | null>(null);
  const activeWaitingNotificationToastIdsRef = useRef<Map<string, string>>(
    new Map()
  );
  const messageCenterModelRef = useRef<WorkspaceAgentMessageCenterModel | null>(
    null
  );
  const messageCenterModelWorkspaceIdRef = useRef<string | null>(null);
  const sessionEngine = useMemo(
    () => workspaceAgentActivityService.getSessionEngine(workspace.id),
    [workspace.id, workspaceAgentActivityService]
  );
  const messageCenterPresentation = useEngineSelector(
    sessionEngine,
    selectWorkspaceAgentMessageCenterPresentation,
    workspaceAgentMessageCenterPresentationEqual
  );
  const messageCenterItemCutoffUnixMs = useMemo(
    () => Date.now() - MESSAGE_CENTER_VISIBLE_HISTORY_MS,
    [workspace.id]
  );
  const model = useMemo(() => {
    if (messageCenterModelWorkspaceIdRef.current !== workspace.id) {
      messageCenterModelWorkspaceIdRef.current = workspace.id;
      messageCenterModelRef.current = null;
    }
    const nextModel = buildWorkspaceAgentMessageCenterModelFromEngine(
      messageCenterPresentation,
      { sessionMessagesById, workspaceId: workspace.id },
      {
        promptFallbackLabels: {
          constraintHeader: t(
            "workspace.agentMessageCenter.promptConstraintHeader"
          ),
          inputHeader: t("workspace.agentMessageCenter.promptInputHeader"),
          question: t("workspace.agentMessageCenter.promptQuestion"),
          title: t("workspace.agentMessageCenter.promptTitle")
        },
        itemCutoffUnixMs: messageCenterItemCutoffUnixMs,
        workspaceRoot: null
      }
    );
    const stableModel = stabilizeWorkspaceAgentMessageCenterModel(
      messageCenterModelRef.current,
      nextModel
    );
    messageCenterModelRef.current = stableModel;
    return stableModel;
  }, [
    messageCenterPresentation,
    messageCenterItemCutoffUnixMs,
    sessionMessagesById,
    t,
    workspace.id
  ]);
  const waitingItems = useMemo(
    () => model.items.filter(isWaitingMessageCenterItem),
    [model.items]
  );
  const triggerPetMood = useEngineSelector(
    sessionEngine,
    resolveWorkspaceAgentStatusPetMood
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
  useEffect(
    () =>
      registerWorkspaceMessageCenterOpenHandler(workspace.id, () => {
        setOpen(true);
      }),
    [setOpen, workspace.id]
  );

  useEffect(() => {
    requestedMessageSummarySessionIdsRef.current.clear();
    setSessionMessagesById({});
    seenWaitingNotificationKeysRef.current = null;
    for (const toastId of activeWaitingNotificationToastIdsRef.current.values()) {
      toast.dismiss(toastId);
    }
    activeWaitingNotificationToastIdsRef.current.clear();
    setHighlightedMessageCenterItemId(null);
  }, [workspace.id]);

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
    [launchNode, setOpen]
  );

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
      if (
        !shouldShowWorkspaceAgentDecisionToast({
          agentGuiSessionOpen: isWorkspaceAgentGuiSessionOpen(
            workspace.id,
            item.agentSessionId
          ),
          messageCenterOpen: open,
          windowForeground: windowForegroundVisibility.isForeground()
        })
      ) {
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
              const interaction = selectEnginePendingInteractions(
                sessionEngine.getSnapshot(),
                item.agentSessionId
              ).find((candidate) => candidate.requestId === input.requestId);
              if (!interaction) return;
              sessionEngine.dispatch({
                type: "interaction/responseRequested",
                workspaceId: workspace.id,
                agentSessionId: item.agentSessionId,
                requestId: input.requestId,
                turnId: interaction.turnId,
                commandId: interactionCommandId({
                  workspaceId: workspace.id,
                  agentSessionId: item.agentSessionId,
                  requestId: input.requestId
                }),
                ...(input.action ? { action: input.action } : {}),
                ...(input.optionId ? { optionId: input.optionId } : {}),
                ...(input.payload ? { payload: input.payload } : {})
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
    windowForegroundVisibility,
    workspace.id,
    sessionEngine
  ]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const sessionsById = new Map(
      messageCenterPresentation.consumers.map(({ session }) => [
        session.agentSessionId,
        session
      ])
    );
    const targets = model.items
      .slice(0, MESSAGE_CENTER_SUMMARY_PREFETCH_ITEM_LIMIT)
      .flatMap((item) => {
        const session = sessionsById.get(item.agentSessionId);
        return session ? [session] : [];
      })
      .filter((session) => {
        const agentSessionId = session.agentSessionId.trim();
        if (!agentSessionId) {
          return false;
        }
        if (requestedMessageSummarySessionIdsRef.current.has(agentSessionId)) {
          return false;
        }
        return !hasCachedWorkspaceAgentSessionMessages(
          sessionMessagesById,
          session
        );
      });
    if (targets.length === 0) {
      return undefined;
    }
    const requestSessionSummary = (session: (typeof targets)[number]) => {
      const agentSessionId = session.agentSessionId.trim();
      if (!agentSessionId) {
        return;
      }
      if (requestedMessageSummarySessionIdsRef.current.has(agentSessionId)) {
        return;
      }
      requestedMessageSummarySessionIdsRef.current.add(agentSessionId);
      void (async () => {
        try {
          const page = await workspaceAgentActivityService.listSessionMessages({
            workspaceId: workspace.id,
            agentSessionId: session.agentSessionId,
            limit: MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT,
            order: "desc"
          });
          setSessionMessagesById((current) => ({
            ...current,
            [session.agentSessionId]: page.messages
          }));
        } catch (error) {
          requestedMessageSummarySessionIdsRef.current.delete(agentSessionId);
          console.error(
            "[workspace-agent-message-summary]",
            JSON.stringify({
              agentSessionId,
              error: error instanceof Error ? error.message : String(error),
              workspaceId: workspace.id
            })
          );
        }
      })();
    };
    for (const session of targets) {
      requestSessionSummary(session);
    }
    return undefined;
  }, [
    model.items,
    open,
    messageCenterPresentation,
    sessionMessagesById,
    workspace.id,
    workspaceAgentActivityService
  ]);

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
        launchGroupChat: requestGroupChatLaunch,
        openBrowserUrl: requestWorkspaceBrowserLaunch,
        workspaceId: workspace.id
      });
    },
    [launchNode, workbenchHostService, workspace.id]
  );
  const closeMessageCenter = useCallback(() => {
    setOpen(false);
  }, [setOpen]);
  const handleHighlightedMessageCenterItemSettled = useCallback(
    (itemId: string) => {
      setHighlightedMessageCenterItemId((current) =>
        current === itemId ? null : current
      );
    },
    []
  );
  const handleMessageCenterNotificationActioned = useCallback(
    (input: { action: string; provider: string }) => {
      void new MessageCenterNotificationActionedReporter(
        {
          action: input.action,
          provider: input.provider
        },
        {
          reporterService
        }
      ).report();
    },
    [reporterService]
  );
  const handleMessageCenterSubmitPrompt = useCallback(
    async (input: {
      action?: string;
      agentSessionId: string;
      optionId?: string;
      payload?: Record<string, unknown>;
      promptKind?: string;
      requestId: string;
    }) => {
      if (input.promptKind === "plan-implementation") {
        if (
          input.action === "implement" ||
          input.action === "feedback" ||
          input.action === "skip"
        ) {
          dispatchAgentPlanPromptAction({
            action: input.action,
            agentSessionId: input.agentSessionId,
            engine: sessionEngine,
            feedbackText:
              typeof input.payload?.text === "string"
                ? input.payload.text
                : undefined,
            requestId: input.requestId,
            workspaceId: workspace.id
          });
        }
        return;
      }
      const interaction = selectEnginePendingInteractions(
        sessionEngine.getSnapshot(),
        input.agentSessionId
      ).find((candidate) => candidate.requestId === input.requestId);
      if (!interaction) return;
      sessionEngine.dispatch({
        type: "interaction/responseRequested",
        agentSessionId: input.agentSessionId,
        commandId: interactionCommandId({
          workspaceId: workspace.id,
          agentSessionId: input.agentSessionId,
          requestId: input.requestId
        }),
        requestId: input.requestId,
        turnId: interaction.turnId,
        workspaceId: workspace.id,
        ...(input.action ? { action: input.action } : {}),
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(input.payload ? { payload: input.payload } : {})
      });
    },
    [sessionEngine, workspace.id]
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
                open && "text-[var(--workbench-chrome-active-foreground)]"
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
              <WorkspaceAgentStatusPetIcon mood={triggerPetMood} />
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
        onClose={closeMessageCenter}
        onHighlightedItemSettled={handleHighlightedMessageCenterItemSettled}
        onLinkAction={handleLinkAction}
        onNotificationActioned={handleMessageCenterNotificationActioned}
        onOpenChat={openMessageCenterChat}
        promptStatus={(item) =>
          workspaceAgentMessageCenterPromptStatus(
            messageCenterPresentation,
            item
          )
        }
        onSubmitPrompt={handleMessageCenterSubmitPrompt}
      />
    </>
  );
}

function interactionCommandId(input: {
  agentSessionId: string;
  requestId: string;
  turnId?: string;
  workspaceId: string;
}): string {
  return [
    input.workspaceId,
    input.agentSessionId,
    input.turnId ?? "interaction",
    input.requestId
  ].join(":");
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
      <Button
        type="button"
        aria-label={closeLabel}
        className="workspace-agent-decision-toast__close absolute top-0 right-0 z-[2] size-6 translate-x-[35%] -translate-y-[35%] rounded-full border-[var(--line-2)] bg-[var(--background-panel)] text-[var(--text-secondary)] shadow-sm hover:bg-[var(--background-fronted)] hover:text-[var(--text-primary)] focus-visible:ring-[color-mix(in_srgb,var(--border-focus)_30%,transparent)]"
        size="icon-xs"
        variant="chrome"
        onClick={onClose}
      >
        <CloseIcon className="size-4" />
      </Button>
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

function hasCachedWorkspaceAgentSessionMessages(
  sessionMessagesById: Readonly<Record<string, AgentActivityMessage[]>>,
  session: CanonicalAgentSession
): boolean {
  return workspaceAgentSessionMessageAliases(session).some(
    (alias) => (sessionMessagesById[alias]?.length ?? 0) > 0
  );
}

function workspaceAgentSessionMessageAliases(
  session: CanonicalAgentSession
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
