import { Button } from "@tutti-os/ui-system/components";
import type { AgentActivityEditRetryRecoveryAction } from "@tutti-os/agent-activity-core";
import type { AgentGUIEditRetryPresentation } from "../model/agentGUIEditRetryModel";
import { translate } from "../../../i18n";

export function AgentGUIEditRetryStatus({
  presentation,
  onRecover
}: {
  presentation: AgentGUIEditRetryPresentation;
  onRecover: (action: AgentActivityEditRetryRecoveryAction) => Promise<void>;
}): React.JSX.Element | null {
  if (presentation.state === "ready") {
    return null;
  }
  if (presentation.state === "terminal") {
    return null;
  }
  const confirmedFailure = isConfirmedFailure(presentation);
  if (!confirmedFailure) {
    return null;
  }
  const canReconcile = presentation.availableActions.includes("reconcile");
  const canRetryReplacement =
    presentation.availableActions.includes("retry_replacement");
  const canAbandon = presentation.availableActions.includes("abandon");

  return (
    <div
      className="mx-auto flex w-[min(720px,100%)] items-center justify-between gap-3 rounded-lg border border-[var(--line-2,var(--tutti-line-2))] bg-[var(--transparency-block)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
      role="alert"
      data-agent-edit-retry-state={presentation.state}
    >
      <div className="min-w-0">
        <span>{translate("agentHost.agentGui.editRetryFailed")}</span>
      </div>
      {presentation.state === "action_required" &&
      (canReconcile || canRetryReplacement || canAbandon) ? (
        <div className="flex shrink-0 items-center gap-1">
          {canReconcile ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={presentation.actionPending}
              onClick={() => void onRecover("reconcile")}
            >
              {translate("agentHost.agentGui.editRetryReconcile")}
            </Button>
          ) : null}
          {canRetryReplacement ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={presentation.actionPending}
              onClick={() => void onRecover("retry_replacement")}
            >
              {translate("agentHost.agentGui.editRetryRetryReplacement")}
            </Button>
          ) : null}
          {canAbandon ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={presentation.actionPending}
              onClick={() => void onRecover("abandon")}
            >
              {translate("agentHost.agentGui.editRetryAbandon")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function isConfirmedFailure(
  presentation: AgentGUIEditRetryPresentation
): boolean {
  return (
    presentation.state === "action_required" &&
    (presentation.reasonCode === "retry_budget_exhausted" ||
      presentation.reasonCode === "local_state_inconsistent" ||
      presentation.reasonCode === "provider_unsupported" ||
      presentation.reasonCode === "provider_rejected")
  );
}
