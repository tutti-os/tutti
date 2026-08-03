import { Button } from "@tutti-os/ui-system/components";
import type { AgentActivityEditRetryRecoveryAction } from "@tutti-os/agent-activity-core";
import type { AgentGUIEditRetryPresentation } from "../model/agentGUIEditRetryModel";
import { translate } from "../../../i18n";

export function AgentGUIEditRetryStatus({
  presentation,
  onRecover,
}: {
  presentation: AgentGUIEditRetryPresentation;
  onRecover: (action: AgentActivityEditRetryRecoveryAction) => Promise<void>;
}): React.JSX.Element | null {
  if (presentation.state === "ready") {
    return null;
  }
  const recovering = presentation.state === "recovering";
  const message = translate(editRetryStatusMessageKey(presentation));
  const canReconcile = presentation.availableActions.includes("reconcile");
  const canRetryReplacement =
    presentation.availableActions.includes("retry_replacement");
  const canAbandon = presentation.availableActions.includes("abandon");

  return (
    <div
      className="mx-auto flex w-[min(720px,100%)] items-center justify-between gap-3 rounded-lg border border-[var(--line-2,var(--tutti-line-2))] bg-[var(--transparency-block)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
      role="status"
      data-agent-edit-retry-state={presentation.state}
    >
      <div className="min-w-0">
        <span
          className={recovering ? "tsh-inline-loading-ellipsis" : undefined}
        >
          {message}
        </span>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-[var(--text-tertiary,var(--text-secondary))]">
          <span>
            {translate("agentHost.agentGui.editRetryCurrentSessionOnly")}
          </span>
          {presentation.automatic ? (
            <span>{translate("agentHost.agentGui.editRetryAutomatic")}</span>
          ) : null}
          {presentation.attempt !== null ? (
            <span>
              {translate("agentHost.agentGui.editRetryAttempt", {
                attempt: presentation.attempt,
              })}
            </span>
          ) : null}
          {presentation.nextAttemptAtUnixMs !== null ? (
            <span>
              {translate("agentHost.agentGui.editRetryNextAttempt", {
                time: formatNextAttempt(presentation.nextAttemptAtUnixMs),
              })}
            </span>
          ) : null}
        </div>
        {presentation.actionFeedback !== null ? (
          <div
            className="mt-1 text-[11px] text-[var(--text-secondary)]"
            role="alert"
          >
            {translate(
              presentation.actionFeedback === "refreshing"
                ? "agentHost.agentGui.editRetryActionRefreshing"
                : "agentHost.agentGui.editRetryActionFailed",
            )}
          </div>
        ) : null}
      </div>
      {!recovering && (canReconcile || canRetryReplacement || canAbandon) ? (
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

function editRetryStatusMessageKey(
  presentation: AgentGUIEditRetryPresentation,
):
  | "agentHost.agentGui.editRetryProcessing"
  | "agentHost.agentGui.editRetryRetryWait"
  | "agentHost.agentGui.editRetryCompleted"
  | "agentHost.agentGui.editRetryNeedsAction"
  | "agentHost.agentGui.editRetryRolloutDisabled"
  | "agentHost.agentGui.editRetryProviderUnsupported"
  | "agentHost.agentGui.editRetryProviderOutcomeUnknown"
  | "agentHost.agentGui.editRetryReplacementNotProvenAbsent"
  | "agentHost.agentGui.editRetryBudgetExhausted"
  | "agentHost.agentGui.editRetryLocalStateInconsistent"
  | "agentHost.agentGui.editRetryRecoveryRequired" {
  if (presentation.reasonCode === "rollout_disabled") {
    return "agentHost.agentGui.editRetryRolloutDisabled";
  }
  if (presentation.reasonCode === "provider_unsupported") {
    return "agentHost.agentGui.editRetryProviderUnsupported";
  }
  if (presentation.reasonCode === "provider_outcome_unknown") {
    return "agentHost.agentGui.editRetryProviderOutcomeUnknown";
  }
  if (presentation.reasonCode === "replacement_not_proven_absent") {
    return "agentHost.agentGui.editRetryReplacementNotProvenAbsent";
  }
  if (presentation.reasonCode === "retry_budget_exhausted") {
    return "agentHost.agentGui.editRetryBudgetExhausted";
  }
  if (presentation.reasonCode === "local_state_inconsistent") {
    return "agentHost.agentGui.editRetryLocalStateInconsistent";
  }
  if (presentation.reasonCode === "recovery_required") {
    return "agentHost.agentGui.editRetryRecoveryRequired";
  }
  switch (presentation.state) {
    case "recovering":
      return "agentHost.agentGui.editRetryProcessing";
    case "retry_wait":
      return "agentHost.agentGui.editRetryRetryWait";
    case "terminal":
      return "agentHost.agentGui.editRetryCompleted";
    case "action_required":
    case "ready":
      return "agentHost.agentGui.editRetryNeedsAction";
  }
}

function formatNextAttempt(nextAttemptAtUnixMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(nextAttemptAtUnixMs));
}
