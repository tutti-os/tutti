import { Button, DeleteIcon, EditIcon, StatusDot } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import type {
  WorkspaceAgentDefinition,
  WorkspaceAutomationRule,
  WorkspaceSettingsAutomationRulesSnapshotState
} from "../services/workspaceSettingsTypes";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";

export interface WorkspaceAutomationRuleRowProps {
  agents: readonly WorkspaceAgentDefinition[];
  automationRulesState: WorkspaceSettingsAutomationRulesSnapshotState;
  rule: WorkspaceAutomationRule;
}

export function WorkspaceAutomationRuleRow({
  agents,
  automationRulesState,
  rule
}: WorkspaceAutomationRuleRowProps) {
  const { t } = useTranslation();
  const { service } = useWorkspaceSettingsService();
  const confirmingDelete =
    automationRulesState.confirmingDeleteRuleID === rule.id;
  const deleting = automationRulesState.deletingRuleID === rule.id;
  const sourceAgent = agents.find(
    (agent) => agent.id === rule.sourceWorkspaceAgentId
  );
  const targetID = rule.target.workspaceAgentId ?? "";
  const targetLabel =
    automationRulesState.targetOptions.find((option) => option.id === targetID)
      ?.name ??
    agents.find((agent) => agent.id === targetID)?.name ??
    targetID;

  return (
    <section className="flex w-full flex-col gap-3 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {rule.name}
            </strong>
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--transparency-block)] px-2 py-0.5">
              <StatusDot size="sm" tone={rule.enabled ? "green" : "neutral"} />
              <span className="text-[11px] text-[var(--text-secondary)]">
                {rule.enabled
                  ? t("workspace.settings.apps.automationRules.enabled")
                  : t("workspace.settings.apps.automationRules.disabled")}
              </span>
            </span>
          </div>
          {rule.prompt ? (
            <p className="m-0 mt-1 line-clamp-2 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
              {rule.prompt}
            </p>
          ) : null}
        </div>

        {confirmingDelete ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[12px] text-[var(--text-secondary)]">
              {t("workspace.settings.apps.automationRules.deleteConfirm")}
            </span>
            <Button
              disabled={deleting}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                void service.automationRules.confirmDeleteRule(rule.id);
              }}
            >
              {deleting
                ? t("workspace.settings.apps.automationRules.deleting")
                : t("workspace.settings.apps.automationRules.delete")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => service.automationRules.cancelDeleteRule()}
            >
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              aria-label={t("workspace.settings.apps.automationRules.edit")}
              disabled={automationRulesState.draft !== null}
              size="icon"
              title={t("workspace.settings.apps.automationRules.edit")}
              type="button"
              variant="ghost"
              onClick={() => service.automationRules.beginEditRule(rule.id)}
            >
              <EditIcon aria-hidden="true" size={15} />
            </Button>
            <Button
              aria-label={t("workspace.settings.apps.automationRules.delete")}
              disabled={automationRulesState.deletingRuleID !== null}
              size="icon"
              title={t("workspace.settings.apps.automationRules.delete")}
              type="button"
              variant="ghost"
              onClick={() => service.automationRules.requestDeleteRule(rule.id)}
            >
              <DeleteIcon aria-hidden="true" size={15} />
            </Button>
          </div>
        )}
      </div>

      <dl className="m-0 grid grid-cols-3 gap-x-4 gap-y-2 text-[11px] max-[640px]:grid-cols-1">
        <AutomationRuleMetadata
          label={t("workspace.settings.apps.automationRules.sourceAgentLabel")}
          value={
            sourceAgent?.name ??
            rule.sourceWorkspaceAgentId ??
            t("workspace.settings.apps.automationRules.allAgents")
          }
        />
        <AutomationRuleMetadata
          label={t("workspace.settings.apps.automationRules.targetLabel")}
          value={targetLabel}
        />
        <AutomationRuleMetadata
          label={t("workspace.settings.apps.automationRules.budgetLabel")}
          value={t("workspace.settings.apps.automationRules.budgetSummary", {
            runs: String(rule.budget.maxRunsPerSession),
            tokens: String(rule.budget.maxTotalTokensPerSession)
          })}
        />
      </dl>

      {automationRulesState.feedback?.kind === "deleteFailed" &&
      confirmingDelete ? (
        <p className="m-0 text-[12px] text-[var(--state-danger)]">
          {t("workspace.settings.apps.automationRules.deleteFailed")}
        </p>
      ) : null}
    </section>
  );
}

function AutomationRuleMetadata({
  label,
  value
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[var(--text-tertiary)]">{label}</dt>
      <dd className="m-0 mt-0.5 truncate text-[var(--text-secondary)]">
        {value}
      </dd>
    </div>
  );
}
