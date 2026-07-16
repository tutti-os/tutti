import { useEffect, useMemo, useRef, useState } from "react";
import {
  AgentInteractivePromptSurface,
  buildWorkspaceAgentInteractivePromptLabels,
  isWaitingMessageCenterItem,
  type WorkspaceAgentMessageCenterItem,
  type WorkspaceAgentMessageCenterModel
} from "@tutti-os/agent-gui/agent-message-center";
import {
  selectEngineInteraction,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { Button, CloseIcon, StatusDot, toast } from "@tutti-os/ui-system";
import { INotificationService } from "@tutti-os/ui-notifications";
import { useService } from "@tutti-os/infra/di";
import {
  createDocumentNotificationVisibilityState,
  type CompositeNotificationMessage
} from "@renderer/lib/compositeNotificationService";
import { useTranslation } from "@renderer/i18n";
import {
  buildWorkspaceAgentDecisionNotification,
  type WorkspaceAgentDecisionSubmitInput
} from "../services/workspaceAgentDecisionNotification";
import { shouldShowWorkspaceAgentDecisionToast } from "../services/workspaceAgentDecisionToastVisibility";

const WORKSPACE_AGENT_DECISION_TOAST_DURATION = Infinity;
const workspaceAgentDecisionToastClassName = "workspace-agent-decision-toast";

export function useWorkspaceAgentDecisionNotifications(input: {
  isAgentGuiSessionOpen?: (agentSessionId: string) => boolean;
  messageCenterOpen: boolean;
  model: WorkspaceAgentMessageCenterModel;
  sendBackgroundNotification: boolean;
  sessionEngine: AgentSessionEngine;
  workspaceId: string;
}): void {
  const {
    isAgentGuiSessionOpen,
    messageCenterOpen,
    model,
    sendBackgroundNotification,
    sessionEngine,
    workspaceId
  } = input;
  const { t } = useTranslation();
  const notifications = useService(INotificationService);
  const windowForegroundVisibility = useMemo(
    () =>
      createDocumentNotificationVisibilityState({
        hasFocus: () => document.hasFocus(),
        visibilityState: () => document.visibilityState
      }),
    []
  );
  const waitingItems = useMemo(
    () => model.items.filter(isWaitingMessageCenterItem),
    [model.items]
  );
  const seenWaitingNotificationKeysRef = useRef<Set<string> | null>(null);
  const activeWaitingNotificationToastIdsRef = useRef<Map<string, string>>(
    new Map()
  );

  useEffect(() => {
    seenWaitingNotificationKeysRef.current = null;
    dismissActiveDecisionToasts(activeWaitingNotificationToastIdsRef.current);
  }, [workspaceId]);

  useEffect(
    () => () => {
      dismissActiveDecisionToasts(activeWaitingNotificationToastIdsRef.current);
    },
    []
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
      if (sendBackgroundNotification) {
        const osMessage: CompositeNotificationMessage = {
          description: notification.description,
          level: "warning",
          navigation: {
            agentSessionId: item.agentSessionId,
            provider: item.provider,
            workspaceId
          },
          // The decision toast below covers the foreground in-app face.
          presentation: "background-only",
          title: t("workspace.agentMessageCenter.waitingNotificationTitle", {
            title: notification.conversationTitle || notification.agentName
          })
        };
        notifications.notify(osMessage);
      }
      if (
        !shouldShowWorkspaceAgentDecisionToast({
          agentGuiSessionOpen:
            isAgentGuiSessionOpen?.(item.agentSessionId) ?? false,
          messageCenterOpen,
          windowForeground: windowForegroundVisibility.isForeground()
        })
      ) {
        continue;
      }
      const toastId = `workspace-agent-waiting:${workspaceId}:${notificationKey}`;
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
            onSubmit={async (submitInput) => {
              const target = item.pendingInteractionTarget;
              if (!target || target.requestId !== submitInput.requestId) return;
              const interaction = selectEngineInteraction(
                sessionEngine.getSnapshot(),
                target.agentSessionId,
                target.turnId,
                target.requestId
              );
              if (interaction?.status !== "pending") return;
              sessionEngine.dispatch({
                type: "interaction/responseRequested",
                workspaceId,
                agentSessionId: target.agentSessionId,
                requestId: target.requestId,
                turnId: target.turnId,
                commandId: interactionCommandId({
                  workspaceId,
                  agentSessionId: target.agentSessionId,
                  requestId: target.requestId,
                  turnId: target.turnId
                }),
                ...(submitInput.action ? { action: submitInput.action } : {}),
                ...(submitInput.optionId
                  ? { optionId: submitInput.optionId }
                  : {}),
                ...(submitInput.payload ? { payload: submitInput.payload } : {})
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
    isAgentGuiSessionOpen,
    messageCenterOpen,
    notifications,
    sendBackgroundNotification,
    sessionEngine,
    t,
    waitingItems,
    windowForegroundVisibility,
    workspaceId
  ]);
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
            onSubmit={(submitInput) => {
              setIsSubmitting(true);
              void onSubmit(submitInput).catch(() => {
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
  const target = item.pendingInteractionTarget;
  if (target) {
    return [
      target.agentSessionId,
      "interaction",
      target.turnId,
      target.requestId
    ].join(":");
  }
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

function dismissActiveDecisionToasts(toastIds: Map<string, string>): void {
  for (const toastId of toastIds.values()) {
    toast.dismiss(toastId);
  }
  toastIds.clear();
}
