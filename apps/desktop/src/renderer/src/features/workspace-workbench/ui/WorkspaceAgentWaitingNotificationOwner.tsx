import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  AgentInteractivePromptSurface,
  buildWorkspaceAgentInteractivePromptLabels,
  isWaitingMessageCenterItem,
  type WorkspaceAgentMessageCenterItem
} from "@tutti-os/agent-gui/agent-message-center";
import { Button, CloseIcon, StatusDot, toast } from "@tutti-os/ui-system";
import { INotificationService } from "@tutti-os/ui-notifications";
import { useService } from "@tutti-os/infra/di";
import {
  createDocumentNotificationVisibilityState,
  type CompositeNotificationMessage
} from "@renderer/lib/compositeNotificationService";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import { useTranslation } from "@renderer/i18n";
import {
  buildWorkspaceAgentDecisionNotification,
  type WorkspaceAgentDecisionSubmitInput
} from "../services/workspaceAgentDecisionNotification.ts";
import { shouldShowWorkspaceAgentDecisionToast } from "../services/workspaceAgentDecisionToastVisibility.ts";
import { isWorkspaceAgentGuiSessionOpen } from "../services/workspaceAgentGuiOpenSessionCoordinator.ts";
import { workspaceAgentWaitingNotificationLeaseRegistry } from "../services/workspaceAgentWaitingNotificationLease.ts";
import { useWorkspaceAgentMessageCenterModel } from "./useWorkspaceAgentMessageCenterModel.ts";

const decisionToastDuration = Infinity;
const decisionToastClassName = "workspace-agent-decision-toast";

export function WorkspaceAgentWaitingNotificationOwner({
  messageCenterOpen = false,
  showDecisionToasts = true,
  workspaceId
}: {
  messageCenterOpen?: boolean;
  showDecisionToasts?: boolean;
  workspaceId: string;
}) {
  const contenderRef = useRef<object>({});
  const subscribe = useCallback(
    (listener: () => void) =>
      workspaceAgentWaitingNotificationLeaseRegistry.register(
        workspaceId,
        contenderRef.current,
        listener
      ),
    [workspaceId]
  );
  const ownsLease = useSyncExternalStore(
    subscribe,
    () =>
      workspaceAgentWaitingNotificationLeaseRegistry.isOwner(
        workspaceId,
        contenderRef.current
      ),
    () => false
  );
  return ownsLease ? (
    <WorkspaceAgentWaitingNotificationRuntime
      messageCenterOpen={messageCenterOpen}
      showDecisionToasts={showDecisionToasts}
      workspaceId={workspaceId}
    />
  ) : null;
}

function WorkspaceAgentWaitingNotificationRuntime({
  messageCenterOpen,
  showDecisionToasts,
  workspaceId
}: {
  messageCenterOpen: boolean;
  showDecisionToasts: boolean;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const notifications = useService(INotificationService);
  const workspaceAgentActivityService = useService(
    IWorkspaceAgentActivityService
  );
  const { model } = useWorkspaceAgentMessageCenterModel({
    workspaceAgentActivityService,
    workspaceId
  });
  const waitingItems = useMemo(
    () => model.items.filter(isWaitingMessageCenterItem),
    [model.items]
  );
  const windowForegroundVisibility = useMemo(
    () =>
      createDocumentNotificationVisibilityState({
        hasFocus: () => document.hasFocus(),
        visibilityState: () => document.visibilityState
      }),
    []
  );
  const seenKeysRef = useRef<Set<string> | null>(null);
  const activeToastIdsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    seenKeysRef.current = null;
    for (const toastId of activeToastIdsRef.current.values()) {
      toast.dismiss(toastId);
    }
    activeToastIdsRef.current.clear();
  }, [workspaceId]);

  useEffect(
    () => () => {
      for (const toastId of activeToastIdsRef.current.values()) {
        toast.dismiss(toastId);
      }
      activeToastIdsRef.current.clear();
    },
    []
  );

  useEffect(() => {
    const waitingEntries = waitingItems.map(
      (item) => [waitingNotificationKey(item), item] as const
    );
    const currentKeys = new Set(waitingEntries.map(([key]) => key));
    for (const [notificationKey, toastId] of activeToastIdsRef.current) {
      if (!currentKeys.has(notificationKey)) {
        toast.dismiss(toastId);
        activeToastIdsRef.current.delete(notificationKey);
      }
    }
    const seenKeys = seenKeysRef.current;
    if (!seenKeys) {
      seenKeysRef.current = currentKeys;
      return;
    }
    seenKeysRef.current = new Set([...seenKeys, ...currentKeys]);
    for (const [notificationKey, item] of waitingEntries) {
      if (seenKeys.has(notificationKey)) {
        continue;
      }
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
          workspaceId
        },
        presentation: "background-only",
        title: t("workspace.agentMessageCenter.waitingNotificationTitle", {
          title: notification.conversationTitle || notification.agentName
        })
      };
      notifications.notify(osMessage);
      if (!showDecisionToasts) {
        continue;
      }
      if (
        !shouldShowWorkspaceAgentDecisionToast({
          agentGuiSessionOpen: isWorkspaceAgentGuiSessionOpen(
            workspaceId,
            item.agentSessionId
          ),
          messageCenterOpen,
          windowForeground: windowForegroundVisibility.isForeground()
        })
      ) {
        continue;
      }
      const toastId = `workspace-agent-waiting:${workspaceId}:${notificationKey}`;
      activeToastIdsRef.current.set(notificationKey, toastId);
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
              activeToastIdsRef.current.delete(notificationKey);
              toast.dismiss(id);
            }}
            onSubmit={async (submitInput) => {
              await workspaceAgentActivityService.submitInteractive({
                workspaceId,
                agentSessionId: item.agentSessionId,
                requestId: submitInput.requestId,
                action: submitInput.action ?? null,
                optionId: submitInput.optionId ?? null,
                payload: submitInput.payload ?? null
              });
              activeToastIdsRef.current.delete(notificationKey);
              toast.dismiss(id);
            }}
          />
        ),
        {
          className: decisionToastClassName,
          duration: decisionToastDuration,
          id: toastId
        }
      );
    }
  }, [
    messageCenterOpen,
    notifications,
    showDecisionToasts,
    t,
    waitingItems,
    windowForegroundVisibility,
    workspaceAgentActivityService,
    workspaceId
  ]);

  return null;
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
        aria-label={closeLabel}
        className="workspace-agent-decision-toast__close absolute top-0 right-0 z-[2] size-6 translate-x-[35%] -translate-y-[35%] rounded-full border-[var(--line-2)] bg-[var(--background-panel)] text-[var(--text-secondary)] shadow-sm hover:bg-[var(--background-fronted)] hover:text-[var(--text-primary)] focus-visible:ring-[color-mix(in_srgb,var(--border-focus)_30%,transparent)]"
        size="icon-xs"
        type="button"
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
              pulse
              size="sm"
              title={waitingStatusLabel}
              tone="amber"
            />
            <span>{waitingStatusLabel}</span>
          </span>
        </div>
        <div className="workspace-agent-decision-toast__prompt min-w-0">
          <AgentInteractivePromptSurface
            embedded
            isSubmitting={isSubmitting}
            keyboardShortcuts={false}
            labels={promptLabels}
            prompt={prompt}
            onSubmit={(submitInput) => {
              setIsSubmitting(true);
              void onSubmit(submitInput).catch(() => setIsSubmitting(false));
            }}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-normal leading-5 text-[var(--text-secondary)]">
          <span className="inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--line-1)] bg-[var(--transparency-block)]">
            <img
              alt={agentName}
              className="size-full object-cover"
              decoding="async"
              draggable={false}
              src={agentIconUrl}
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
  return requestId
    ? `${item.agentSessionId}:prompt:${requestId}`
    : [
        item.agentSessionId,
        "attention",
        item.needsAttentionKind ?? "waiting",
        item.sortTimeUnixMs
      ].join(":");
}
