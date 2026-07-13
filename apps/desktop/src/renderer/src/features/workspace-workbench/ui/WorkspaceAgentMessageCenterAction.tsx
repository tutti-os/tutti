import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceAgentMessageCenterPanel } from "@tutti-os/agent-gui/agent-message-center";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import type { WorkbenchHostChromeRenderContext } from "@tutti-os/workbench-surface";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { useService } from "@tutti-os/infra/di";
import { MessageCenterOpenedReporter } from "@renderer/features/analytics/reporters/message-center-opened/messageCenterOpenedReporter.ts";
import { MessageCenterNotificationActionedReporter } from "@renderer/features/analytics/reporters/message-center-notification-actioned/messageCenterNotificationActionedReporter.ts";
import { IReporterService } from "@renderer/features/analytics";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { resolveWorkspaceAgentMessageCenterTrigger } from "../services/workspaceAgentMessageCenterTrigger.ts";
import { toggleWorkspaceAgentMessageCenter } from "../services/workspaceAgentMessageCenterToggle.ts";
import { registerWorkspaceMessageCenterOpenHandler } from "../services/workspaceMessageCenterCoordinator.ts";
import { createWorkspaceAgentGuiSessionLaunchRequest } from "../services/workspaceAgentGuiLaunch.ts";
import { requestWorkspaceBrowserLaunch } from "../services/workspaceBrowserLaunchCoordinator.ts";
import { requestWorkspaceFilesLaunch } from "../services/workspaceFilesLaunchCoordinator.ts";
import { requestWorkspaceIssueManagerLaunch } from "../services/workspaceIssueManagerLaunchCoordinator.ts";
import { requestGroupChatLaunch } from "../services/groupChatLaunchCoordinator.ts";
import { resolveWorkspaceAgentStatusPetMood } from "../services/workspaceAgentStatusPetMood.ts";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService.ts";
import { WorkspaceAgentStatusPetIcon } from "./WorkspaceAgentStatusPetIcon.tsx";
import { useWorkspaceAgentMessageCenterModel } from "./useWorkspaceAgentMessageCenterModel.ts";

const MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT = 20;
const MESSAGE_CENTER_SUMMARY_PREFETCH_ITEM_LIMIT = 12;

export function WorkspaceAgentMessageCenterAction({
  handlesNotificationNavigation = true,
  launchNode,
  open,
  setOpen,
  workspace
}: {
  handlesNotificationNavigation?: boolean;
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
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const [highlightedMessageCenterItemId, setHighlightedMessageCenterItemId] =
    useState<string | null>(null);
  const requestedMessageSummarySessionIdsRef = useRef<Set<string>>(new Set());
  const { model, snapshot } = useWorkspaceAgentMessageCenterModel({
    workspaceAgentActivityService,
    workspaceId: workspace.id
  });
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
  useEffect(
    () =>
      registerWorkspaceMessageCenterOpenHandler(workspace.id, () => {
        setOpen(true);
      }),
    [setOpen, workspace.id]
  );

  useEffect(() => {
    requestedMessageSummarySessionIdsRef.current.clear();
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
      snapshot.sessions.map((session) => [session.agentSessionId, session])
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
          snapshot.sessionMessagesById,
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
          await workspaceAgentActivityService.listSessionMessages({
            workspaceId: workspace.id,
            agentSessionId: session.agentSessionId,
            limit: MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT,
            order: "desc"
          });
        } catch {
          requestedMessageSummarySessionIdsRef.current.delete(agentSessionId);
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
    snapshot,
    workspace.id,
    workspaceAgentActivityService
  ]);

  useEffect(() => {
    if (!handlesNotificationNavigation) {
      return undefined;
    }
    return workbenchHostService.onNotificationNavigate((payload) => {
      if (payload.workspaceId !== workspace.id) {
        return;
      }
      openMessageCenterChat({
        agentSessionId: payload.agentSessionId,
        provider: payload.provider
      });
    });
  }, [
    handlesNotificationNavigation,
    openMessageCenterChat,
    workbenchHostService,
    workspace.id
  ]);
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
    },
    [workspace.id, workspaceAgentActivityService]
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
        onSubmitPrompt={handleMessageCenterSubmitPrompt}
      />
    </>
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
