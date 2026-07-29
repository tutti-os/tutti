import { AddIcon, Button } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { WorkspaceAutomationRuleEditor } from "./WorkspaceAutomationRuleEditor";
import { WorkspaceAutomationRuleRow } from "./WorkspaceAutomationRuleRow";

/** Workspace-level action automations backed by daemon AutomationRule CRUD. */
export function WorkspaceAutomationRulesSection() {
  const { t } = useTranslation();
  const { service, state } = useWorkspaceSettingsService();
  const automationRulesState = state.automationRules;
  const draft = automationRulesState.draft;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.apps.automationRules.title")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.35] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.description")}
          </p>
        </div>
        <Button
          className="shrink-0"
          disabled={
            draft !== null ||
            automationRulesState.loading ||
            automationRulesState.loadFailed
          }
          size="sm"
          type="button"
          onClick={() => service.automationRules.beginDraft()}
        >
          <AddIcon aria-hidden="true" className="size-3.5" />
          {t("workspace.settings.apps.automationRules.addRule")}
        </Button>
      </div>

      {automationRulesState.loadFailed ? (
        <div className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3">
          <p className="m-0 text-[12px] text-[var(--state-danger)]">
            {t("workspace.settings.apps.automationRules.loadFailed")}
          </p>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              void service.automationRules.refresh();
            }}
          >
            {t("workspace.settings.apps.automationRules.retry")}
          </Button>
        </div>
      ) : null}

      {!automationRulesState.loading &&
      !automationRulesState.loadFailed &&
      automationRulesState.rules.length === 0 &&
      draft === null ? (
        <div className="flex flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-[var(--border-1)] bg-[var(--transparency-block)] px-4 py-8 text-center">
          <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
            {t("workspace.settings.apps.automationRules.emptyTitle")}
          </p>
          <p className="m-0 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.emptyDescription")}
          </p>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-2">
          {automationRulesState.rules.map((rule) =>
            draft?.automationRuleId === rule.id ? (
              <WorkspaceAutomationRuleEditor
                key={rule.id}
                agents={state.agents.agents}
                draft={draft}
                feedback={automationRulesState.feedback}
                saving={automationRulesState.saving}
                targetCatalog={automationRulesState.targetCatalog}
                targetOptions={automationRulesState.targetOptions}
                onCancel={() => service.automationRules.cancelDraft()}
                onRetryTargetCatalog={() => {
                  void service.automationRules.retryTargetCatalog();
                }}
                onSave={() => {
                  void service.automationRules.saveDraft();
                }}
                onSelectTarget={(targetAgentID) => {
                  void service.automationRules.selectDraftTarget(targetAgentID);
                }}
                onUpdate={(patch) => service.automationRules.updateDraft(patch)}
              />
            ) : (
              <WorkspaceAutomationRuleRow
                key={rule.id}
                agents={state.agents.agents}
                automationRulesState={automationRulesState}
                rule={rule}
              />
            )
          )}
          {draft?.automationRuleId === null ? (
            <WorkspaceAutomationRuleEditor
              agents={state.agents.agents}
              draft={draft}
              feedback={automationRulesState.feedback}
              saving={automationRulesState.saving}
              targetCatalog={automationRulesState.targetCatalog}
              targetOptions={automationRulesState.targetOptions}
              onCancel={() => service.automationRules.cancelDraft()}
              onRetryTargetCatalog={() => {
                void service.automationRules.retryTargetCatalog();
              }}
              onSave={() => {
                void service.automationRules.saveDraft();
              }}
              onSelectTarget={(targetAgentID) => {
                void service.automationRules.selectDraftTarget(targetAgentID);
              }}
              onUpdate={(patch) => service.automationRules.updateDraft(patch)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
