import {
  Button,
  CloseIcon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import type { DesktopI18nKey } from "../../../../../shared/i18n/index.ts";
import type {
  WorkspaceAgentDefinition,
  WorkspaceAutomationRuleAction,
  WorkspaceAutomationRuleDraft,
  WorkspaceAutomationRuleFeedback,
  WorkspaceAutomationRuleTrigger,
  WorkspaceModelPlan
} from "../services/workspaceSettingsTypes";
import {
  workspaceSettingsInputClass,
  workspaceSettingsSelectContentClass,
  workspaceSettingsSelectTriggerClass
} from "./workspaceSettingsFieldStyles";

const NO_SOURCE_VALUE = "__all_sources__";
const NO_TARGET_AGENT_VALUE = "__no_target_agent__";
const NO_PLAN_VALUE = "__no_plan__";
const PLAN_DEFAULT_MODEL_VALUE = "__plan_default__";
const textareaClass =
  "min-h-[88px] resize-y border-[var(--border-1)] bg-[var(--transparency-block)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] hover:bg-[var(--transparency-hover)] focus-visible:border-[var(--border-focus)] focus-visible:ring-0";
const selectContentStyle = { zIndex: "var(--z-panel-popover)" } as const;

const actionLabelKeys: Record<WorkspaceAutomationRuleAction, DesktopI18nKey> = {
  consult: "workspace.settings.apps.automationRules.actions.consult",
  delegate: "workspace.settings.apps.automationRules.actions.delegate",
  fork: "workspace.settings.apps.automationRules.actions.fork",
  handoff: "workspace.settings.apps.automationRules.actions.handoff"
};

const automationRuleActions = [
  "consult",
  "fork",
  "delegate",
  "handoff"
] as const satisfies readonly WorkspaceAutomationRuleAction[];

export interface WorkspaceAutomationRuleEditorProps {
  agents: readonly WorkspaceAgentDefinition[];
  draft: Readonly<WorkspaceAutomationRuleDraft>;
  feedback: WorkspaceAutomationRuleFeedback | null;
  modelPlans: readonly WorkspaceModelPlan[];
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  onUpdate: (patch: Partial<WorkspaceAutomationRuleDraft>) => void;
}

export function WorkspaceAutomationRuleEditor({
  agents,
  draft,
  feedback,
  modelPlans,
  saving,
  onCancel,
  onSave,
  onUpdate
}: WorkspaceAutomationRuleEditorProps) {
  const { t } = useTranslation();
  const consult = draft.action === "consult";
  const sourceAgents = agents.filter(
    (agent) => agent.enabled || agent.id === draft.sourceWorkspaceAgentId
  );
  const targetAgents = agents.filter(
    (agent) => agent.enabled || agent.id === draft.targetWorkspaceAgentId
  );
  const availablePlans = modelPlans.filter(
    (plan) => plan.enabled || plan.id === draft.modelPlanId
  );
  const selectedPlan =
    availablePlans.find((plan) => plan.id === draft.modelPlanId) ?? null;
  const selectedModelKnown =
    !draft.model ||
    selectedPlan?.models.some((model) => model.id === draft.model) === true;
  const editing = draft.automationRuleId !== null;

  return (
    <section className="flex w-full flex-col gap-4 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {editing
              ? t("workspace.settings.apps.automationRules.editTitle", {
                  rule: draft.name
                })
              : t("workspace.settings.apps.automationRules.addRule")}
          </strong>
          <p className="m-0 mt-1 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.editorDescription")}
          </p>
        </div>
        <Button
          aria-label={t("common.cancel")}
          size="icon"
          type="button"
          variant="ghost"
          onClick={onCancel}
        >
          <CloseIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.nameLabel")}
          </span>
          <Input
            className={workspaceSettingsInputClass}
            placeholder={t(
              "workspace.settings.apps.automationRules.namePlaceholder"
            )}
            type="text"
            value={draft.name}
            onChange={(event) => onUpdate({ name: event.currentTarget.value })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.triggerLabel")}
          </span>
          <Select
            value={draft.trigger}
            onValueChange={(value) =>
              onUpdate({ trigger: value as WorkspaceAutomationRuleTrigger })
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.apps.automationRules.triggerLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={selectContentStyle}
            >
              <SelectItem value="on_task_complete">
                {t(
                  "workspace.settings.apps.automationRules.triggers.onTaskComplete"
                )}
              </SelectItem>
              <SelectItem value="on_task_failed">
                {t(
                  "workspace.settings.apps.automationRules.triggers.onTaskFailed"
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.actionLabel")}
          </span>
          <Select
            value={draft.action}
            onValueChange={(value) =>
              onUpdate({ action: value as WorkspaceAutomationRuleAction })
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.apps.automationRules.actionLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={selectContentStyle}
            >
              {automationRuleActions.map((action) => (
                <SelectItem key={action} value={action}>
                  {t(actionLabelKeys[action])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.sourceAgentLabel")}
          </span>
          <Select
            value={draft.sourceWorkspaceAgentId || NO_SOURCE_VALUE}
            onValueChange={(value) =>
              onUpdate({
                sourceWorkspaceAgentId: value === NO_SOURCE_VALUE ? "" : value
              })
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.apps.automationRules.sourceAgentLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={selectContentStyle}
            >
              <SelectItem value={NO_SOURCE_VALUE}>
                {t("workspace.settings.apps.automationRules.allAgents")}
              </SelectItem>
              {sourceAgents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      {consult ? (
        <ConsultTargetFields
          draft={draft}
          modelPlans={availablePlans}
          selectedModelKnown={selectedModelKnown}
          selectedPlan={selectedPlan}
          onUpdate={onUpdate}
        />
      ) : (
        <AgentTargetFields
          agents={targetAgents}
          draft={draft}
          onUpdate={onUpdate}
        />
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.automationRules.promptLabel")}
        </span>
        <Textarea
          className={textareaClass}
          placeholder={t(
            "workspace.settings.apps.automationRules.promptPlaceholder"
          )}
          value={draft.prompt}
          onChange={(event) => onUpdate({ prompt: event.currentTarget.value })}
        />
      </label>

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.maxRunsLabel")}
          </span>
          <Input
            className={workspaceSettingsInputClass}
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={draft.maxRunsPerSession}
            onChange={(event) =>
              onUpdate({ maxRunsPerSession: event.currentTarget.value })
            }
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.automationRules.maxTokensLabel")}
          </span>
          <Input
            className={workspaceSettingsInputClass}
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={draft.maxTotalTokensPerSession}
            onChange={(event) =>
              onUpdate({
                maxTotalTokensPerSession: event.currentTarget.value
              })
            }
          />
        </label>
      </div>
      <p className="m-0 -mt-2 text-[10px] leading-[1.4] text-[var(--text-tertiary)]">
        {t("workspace.settings.apps.automationRules.budgetDescription")}
      </p>

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          <Switch
            aria-label={t(
              "workspace.settings.apps.automationRules.enabledLabel"
            )}
            checked={draft.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          {t("workspace.settings.apps.automationRules.enabledLabel")}
        </label>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={saving} type="button" onClick={onSave}>
            {saving
              ? t("workspace.settings.apps.automationRules.saving")
              : t("workspace.settings.apps.automationRules.save")}
          </Button>
        </div>
      </div>

      {feedback ? (
        <p className="m-0 text-[12px] leading-[1.4] text-[var(--state-danger)]">
          {t(resolveFeedbackKey(feedback))}
        </p>
      ) : null}
    </section>
  );
}

function ConsultTargetFields({
  draft,
  modelPlans,
  selectedModelKnown,
  selectedPlan,
  onUpdate
}: {
  draft: Readonly<WorkspaceAutomationRuleDraft>;
  modelPlans: readonly WorkspaceModelPlan[];
  selectedModelKnown: boolean;
  selectedPlan: WorkspaceModelPlan | null;
  onUpdate: (patch: Partial<WorkspaceAutomationRuleDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.automationRules.modelPlanLabel")}
        </span>
        <Select
          value={draft.modelPlanId || NO_PLAN_VALUE}
          onValueChange={(value) =>
            onUpdate({
              model: "",
              modelPlanId: value === NO_PLAN_VALUE ? "" : value
            })
          }
        >
          <SelectTrigger
            aria-label={t(
              "workspace.settings.apps.automationRules.modelPlanLabel"
            )}
            className={workspaceSettingsSelectTriggerClass}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            className={workspaceSettingsSelectContentClass}
            style={selectContentStyle}
          >
            <SelectItem disabled value={NO_PLAN_VALUE}>
              {t("workspace.settings.apps.automationRules.chooseModelPlan")}
            </SelectItem>
            {modelPlans.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {plan.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.automationRules.modelLabel")}
        </span>
        <Select
          disabled={!selectedPlan}
          value={
            draft.model && selectedModelKnown
              ? draft.model
              : PLAN_DEFAULT_MODEL_VALUE
          }
          onValueChange={(value) =>
            onUpdate({
              model: value === PLAN_DEFAULT_MODEL_VALUE ? "" : value
            })
          }
        >
          <SelectTrigger
            aria-label={t("workspace.settings.apps.automationRules.modelLabel")}
            className={workspaceSettingsSelectTriggerClass}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            className={workspaceSettingsSelectContentClass}
            style={selectContentStyle}
          >
            <SelectItem value={PLAN_DEFAULT_MODEL_VALUE}>
              {t("workspace.settings.apps.automationRules.planDefaultModel")}
            </SelectItem>
            {selectedPlan?.models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.name || model.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <AutomationRuleListField
        label={t(
          "workspace.settings.apps.automationRules.requiredCapabilitiesLabel"
        )}
        placeholder={t(
          "workspace.settings.apps.automationRules.requiredCapabilitiesPlaceholder"
        )}
        value={draft.requiredCapabilities}
        onChange={(requiredCapabilities) => onUpdate({ requiredCapabilities })}
      />
      <div className="flex items-end">
        <p className="m-0 pb-1 text-[11px] leading-[1.4] text-[var(--text-tertiary)]">
          {t("workspace.settings.apps.automationRules.consultToolFree")}
        </p>
      </div>
    </div>
  );
}

function AgentTargetFields({
  agents,
  draft,
  onUpdate
}: {
  agents: readonly WorkspaceAgentDefinition[];
  draft: Readonly<WorkspaceAutomationRuleDraft>;
  onUpdate: (patch: Partial<WorkspaceAutomationRuleDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-3 gap-3 max-[760px]:grid-cols-1">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.automationRules.targetAgentLabel")}
        </span>
        <Select
          value={draft.targetWorkspaceAgentId || NO_TARGET_AGENT_VALUE}
          onValueChange={(value) => {
            if (value !== NO_TARGET_AGENT_VALUE) {
              onUpdate({ targetWorkspaceAgentId: value });
            }
          }}
        >
          <SelectTrigger
            aria-label={t(
              "workspace.settings.apps.automationRules.targetAgentLabel"
            )}
            className={workspaceSettingsSelectTriggerClass}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            className={workspaceSettingsSelectContentClass}
            style={selectContentStyle}
          >
            <SelectItem disabled value={NO_TARGET_AGENT_VALUE}>
              {t("workspace.settings.apps.automationRules.chooseTargetAgent")}
            </SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.automationRules.permissionModeLabel")}
        </span>
        <Input
          className={workspaceSettingsInputClass}
          placeholder={t(
            "workspace.settings.apps.automationRules.permissionModePlaceholder"
          )}
          type="text"
          value={draft.permissionModeId}
          onChange={(event) =>
            onUpdate({ permissionModeId: event.currentTarget.value })
          }
        />
      </label>

      <AutomationRuleListField
        label={t("workspace.settings.apps.automationRules.allowedToolsLabel")}
        placeholder={t(
          "workspace.settings.apps.automationRules.allowedToolsPlaceholder"
        )}
        value={draft.allowedTools}
        onChange={(allowedTools) => onUpdate({ allowedTools })}
      />
    </div>
  );
}

function AutomationRuleListField({
  label,
  placeholder,
  value,
  onChange
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      <Textarea
        className={textareaClass}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <span className="text-[10px] leading-[1.3] text-[var(--text-tertiary)]">
        {t("workspace.settings.apps.automationRules.onePerLine")}
      </span>
    </label>
  );
}

function resolveFeedbackKey(
  feedback: WorkspaceAutomationRuleFeedback
): DesktopI18nKey {
  switch (feedback.kind) {
    case "invalidBudget":
      return "workspace.settings.apps.automationRules.invalidBudget";
    case "requiredFields":
      return "workspace.settings.apps.automationRules.requiredFields";
    default:
      return "workspace.settings.apps.automationRules.saveFailed";
  }
}
