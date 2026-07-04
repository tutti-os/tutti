import { managedAgentRoundedIconUrl } from "@tutti-os/agent-gui/agent-message-center";
import { Button, CloseIcon, StatusDot, toast } from "@tutti-os/ui-system";
import {
  normalizeDesktopAgentGUIProvider,
  requestWorkspaceAgentGuiLaunch
} from "@renderer/features/workspace-agent";
import type {
  WorkspaceAgentOutcomeForegroundNotification,
  WorkspaceAgentOutcomeForegroundNotificationPresenter
} from "../services/workspaceAgentOutcomeNotification";

const WORKSPACE_AGENT_OUTCOME_TOAST_DURATION = 6000;
const workspaceAgentDecisionToastClassName = "workspace-agent-decision-toast";

export function createWorkspaceAgentOutcomeForegroundNotificationPresenter(): WorkspaceAgentOutcomeForegroundNotificationPresenter {
  return {
    show(notification) {
      toast.custom(
        (id) => (
          <WorkspaceAgentOutcomeToast
            agentIconUrl={managedAgentRoundedIconUrl(notification.provider)}
            agentName={notification.agentName}
            body={notification.body}
            closeLabel={notification.closeLabel}
            conversationTitle={notification.conversationTitle}
            level={notification.level}
            statusLabel={notification.statusLabel}
            onClose={() => toast.dismiss(id)}
            onOpen={() => {
              toast.dismiss(id);
              void requestWorkspaceAgentGuiLaunch({
                agentSessionId: notification.agentSessionId,
                provider: normalizeDesktopAgentGUIProvider(
                  notification.provider
                ),
                workspaceId: notification.workspaceId
              });
            }}
          />
        ),
        {
          className: workspaceAgentDecisionToastClassName,
          duration: WORKSPACE_AGENT_OUTCOME_TOAST_DURATION
        }
      );
    }
  };
}

function WorkspaceAgentOutcomeToast({
  agentIconUrl,
  agentName,
  body,
  closeLabel,
  conversationTitle,
  level,
  statusLabel,
  onClose,
  onOpen
}: {
  agentIconUrl: string;
  agentName: string;
  body: string;
  closeLabel: string;
  conversationTitle: string;
  level: WorkspaceAgentOutcomeForegroundNotification["level"];
  statusLabel: string;
  onClose: () => void;
  onOpen: () => void;
}) {
  "use memo";
  const displayTitle = conversationTitle || agentName;
  const tone = level === "success" ? "green" : "red";

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
      <button
        type="button"
        className="workspace-agent-decision-toast__content relative z-[1] grid w-full min-w-0 cursor-pointer gap-2.5 text-left"
        onClick={onOpen}
      >
        <div className="flex min-w-0 items-center justify-between gap-2.5 pr-2">
          <h3 className="min-w-0 truncate text-[13px] font-bold leading-5 text-[var(--text-secondary)]">
            {displayTitle}
          </h3>
          <span
            className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold leading-4 text-[var(--text-secondary)]"
            data-status={level}
            title={statusLabel}
          >
            <StatusDot tone={tone} size="sm" title={statusLabel} />
            <span>{statusLabel}</span>
          </span>
        </div>
        <p className="workspace-agent-decision-toast__outcome-card min-w-0 text-[13px] leading-5 text-[var(--text-secondary)]">
          {body}
        </p>
        <div className="flex min-w-0 items-center gap-2 text-[13px] leading-5 text-[var(--text-secondary)]">
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
      </button>
    </article>
  );
}
