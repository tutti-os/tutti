import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  buildWorkspaceAgentMessageCenterModelFromEngine,
  selectWorkspaceAgentMessageCenterPresentation,
  stabilizeWorkspaceAgentMessageCenterModel,
  workspaceAgentMessageCenterPromptStatus,
  workspaceAgentMessageCenterPresentationEqual,
  WorkspaceAgentMessageCenterPanel,
  dispatchAgentPlanPromptAction,
  useEngineSelector,
  type WorkspaceAgentMessageCenterModel
} from "@tutti-os/agent-gui/agent-message-center";
import {
  type AgentActivityMessage,
  type CanonicalAgentSession,
  selectEngineInteraction
} from "@tutti-os/agent-activity-core";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import type { WorkbenchHostChromeRenderContext } from "@tutti-os/workbench-surface";
import {
  Button,
  MessageCenterIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { useService } from "@tutti-os/infra/di";
import { MessageCenterOpenedReporter } from "@renderer/features/analytics/reporters/message-center-opened/messageCenterOpenedReporter.ts";
import { MessageCenterNotificationActionedReporter } from "@renderer/features/analytics/reporters/message-center-notification-actioned/messageCenterNotificationActionedReporter.ts";
import { IReporterService } from "@renderer/features/analytics";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import { IAgentsService } from "@renderer/features/workspace-agent/services/agentsService.interface.ts";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import { resolveWorkspaceAgentMessageCenterTrigger } from "../services/workspaceAgentMessageCenterTrigger";
import { toggleWorkspaceAgentMessageCenter } from "../services/workspaceAgentMessageCenterToggle";
import { registerWorkspaceMessageCenterOpenHandler } from "../services/workspaceMessageCenterCoordinator";
import { isWorkspaceAgentGuiSessionOpen } from "../services/workspaceAgentGuiOpenSessionCoordinator";
import { createWorkspaceAgentGuiSessionLaunchRequest } from "../services/workspaceAgentGuiLaunch";
import { requestWorkspaceBrowserLaunch } from "../services/workspaceBrowserLaunchCoordinator";
import { requestWorkspaceFilesLaunch } from "../services/workspaceFilesLaunchCoordinator";
import { requestWorkspaceIssueManagerLaunch } from "../services/workspaceIssueManagerLaunchCoordinator";
import { requestGroupChatLaunch } from "../services/groupChatLaunchCoordinator";
import { useWorkspaceAgentDecisionNotifications } from "./useWorkspaceAgentDecisionNotifications";

const MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT = 20;
const MESSAGE_CENTER_SUMMARY_PREFETCH_ITEM_LIMIT = 12;
const MESSAGE_CENTER_VISIBLE_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
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
  const agentsService = useService(IAgentsService);
  const agentDirectory = useSyncExternalStore(
    (listener) => agentsService.subscribe(listener),
    () => agentsService.getSnapshot(),
    () => agentsService.getSnapshot()
  );
  const reporterService = useService(IReporterService);
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const [highlightedMessageCenterItemId, setHighlightedMessageCenterItemId] =
    useState<string | null>(null);
  const [sessionMessagesById, setSessionMessagesById] = useState<
    Record<string, AgentActivityMessage[]>
  >({});
  const requestedMessageSummarySessionIdsRef = useRef<Set<string>>(new Set());
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
        agentPresentations: agentDirectory.agentTargets,
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
    agentDirectory.agentTargets,
    messageCenterItemCutoffUnixMs,
    sessionMessagesById,
    t,
    workspace.id
  ]);
  const isAgentGuiSessionOpenForWorkspace = useCallback(
    (agentSessionId: string) =>
      isWorkspaceAgentGuiSessionOpen(workspace.id, agentSessionId),
    [workspace.id]
  );
  useWorkspaceAgentDecisionNotifications({
    isAgentGuiSessionOpen: isAgentGuiSessionOpenForWorkspace,
    messageCenterOpen: open,
    model,
    sendBackgroundNotification: true,
    sessionEngine,
    workspaceId: workspace.id
  });
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
        getAgentSession: ({ agentSessionId, workspaceId }) =>
          workspaceAgentActivityService.getSession(workspaceId, agentSessionId),
        homeDirectory: workbenchHostService.getHomeDirectory(),
        launchAgentGui: async (input) => {
          const nodeId = await launchNode?.(
            createWorkspaceAgentGuiSessionLaunchRequest({
              agentSessionId: input.agentSessionId,
              agentTargetId: input.agentTargetId,
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
    [
      launchNode,
      workbenchHostService,
      workspace.id,
      workspaceAgentActivityService
    ]
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
      turnId?: string;
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
      if (!input.turnId) return;
      const interaction = selectEngineInteraction(
        sessionEngine.getSnapshot(),
        input.agentSessionId,
        input.turnId,
        input.requestId
      );
      if (interaction?.status !== "pending") return;
      sessionEngine.dispatch({
        type: "interaction/responseRequested",
        agentSessionId: input.agentSessionId,
        commandId: interactionCommandId({
          workspaceId: workspace.id,
          agentSessionId: input.agentSessionId,
          requestId: input.requestId,
          turnId: input.turnId
        }),
        requestId: input.requestId,
        turnId: input.turnId,
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
              <MessageCenterIcon className="shrink-0" />
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
