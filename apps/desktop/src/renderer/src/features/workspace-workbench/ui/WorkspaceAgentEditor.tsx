import {
  Button,
  CloseIcon,
  DeleteIcon,
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
import { modelPlanProtocolForAgentProvider } from "../services/workspaceModelPlanTemplates";
import type {
  WorkspaceAgentDefinition,
  WorkspaceAgentDraft,
  WorkspaceAgentFeedback,
  WorkspaceAgentCapabilityOption,
  WorkspaceAgentHarnessTargetOption,
  WorkspaceModelPlan
} from "../services/workspaceSettingsTypes";
import {
  workspaceSettingsInputClass,
  workspaceSettingsSelectContentClass,
  workspaceSettingsSelectTriggerClass
} from "./workspaceSettingsFieldStyles";
import { WorkspaceAgentCapabilitySelection } from "./WorkspaceAgentCapabilitySelection";

const NO_HARNESS_VALUE = "__no_harness__";
const NO_PLAN_VALUE = "__no_plan__";
const PLAN_DEFAULT_MODEL_VALUE = "__plan_default__";
const textareaClass =
  "min-h-[88px] resize-y border-[var(--border-1)] bg-[var(--transparency-block)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] hover:bg-[var(--transparency-hover)] focus-visible:border-[var(--border-focus)] focus-visible:ring-0";

export function WorkspaceAgentEditor({
  agent,
  draft,
  feedback,
  capabilityCatalog,
  capabilityCatalogLoadFailed,
  capabilityCatalogLoading,
  generating,
  harnessTargets,
  modelPlans,
  recommendingFallback,
  saving,
  onCancel,
  onGenerate,
  onRefreshCapabilityCatalog,
  onRecommendFallback,
  onSave,
  onUpdate
}: {
  agent: WorkspaceAgentDefinition | null;
  draft: Readonly<WorkspaceAgentDraft>;
  feedback: WorkspaceAgentFeedback | null;
  capabilityCatalog: readonly WorkspaceAgentCapabilityOption[];
  capabilityCatalogLoadFailed: boolean;
  capabilityCatalogLoading: boolean;
  generating: boolean;
  harnessTargets: readonly WorkspaceAgentHarnessTargetOption[];
  modelPlans: readonly WorkspaceModelPlan[];
  recommendingFallback: boolean;
  saving: boolean;
  onCancel: () => void;
  onGenerate: () => void;
  onRefreshCapabilityCatalog: () => void;
  onRecommendFallback: () => void;
  onSave: () => void;
  onUpdate: (patch: Partial<WorkspaceAgentDraft>) => void;
}) {
  const { t } = useTranslation();
  const selectedCatalogHarness = harnessTargets.find(
    (target) => target.id === draft.harnessAgentTargetId
  );
  const selectedHarness =
    selectedCatalogHarness ??
    (agent?.harness.agentTargetId === draft.harnessAgentTargetId
      ? {
          enabled: agent.harness.enabled ?? false,
          id: agent.harness.agentTargetId,
          name: agent.harness.name || agent.harness.agentTargetId,
          provider: agent.harness.provider ?? ""
        }
      : null);
  const availableHarnessTargets = harnessTargets.filter(
    (target) => target.enabled || target.id === draft.harnessAgentTargetId
  );
  const harnessOptions =
    selectedHarness && !selectedCatalogHarness
      ? [...availableHarnessTargets, selectedHarness]
      : availableHarnessTargets;
  const protocol = modelPlanProtocolForAgentProvider(
    selectedHarness?.provider ?? ""
  );
  const compatiblePlans = modelPlans.filter(
    (plan) =>
      (protocol === null
        ? plan.id === draft.modelPlanId
        : plan.protocol === protocol) &&
      (plan.enabled || plan.id === draft.modelPlanId)
  );
  const selectedPlan =
    compatiblePlans.find((plan) => plan.id === draft.modelPlanId) ?? null;
  const editing = draft.agentId !== null;
  const fallbackCandidates = modelPlans.filter(
    (plan) => protocol !== null && plan.protocol === protocol && plan.enabled
  );
  const updateFallback = (
    index: number,
    patch: Partial<(typeof draft.modelFallbacks)[number]>
  ) => {
    onUpdate({
      modelFallbacks: draft.modelFallbacks.map((fallback, fallbackIndex) =>
        fallbackIndex === index ? { ...fallback, ...patch } : fallback
      )
    });
  };

  return (
    <section className="flex w-full flex-col gap-4 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {editing
              ? t("workspace.settings.apps.agents.editTitle", {
                  agent: draft.name
                })
              : t("workspace.settings.apps.agents.addAgent")}
          </strong>
          <p className="m-0 mt-1 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.editorDescription")}
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

      <section className="grid gap-2 rounded-[8px] border border-[var(--border-1)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-[var(--text-secondary)]">
              {t("workspace.settings.apps.agents.generateTitle")}
            </div>
            <p className="m-0 mt-1 text-[11px] leading-[1.4] text-[var(--text-tertiary)]">
              {selectedPlan
                ? t("workspace.settings.apps.agents.generateModelDisclosure", {
                    model:
                      selectedPlan.models.find(
                        (model) => model.id === draft.defaultModel
                      )?.name ||
                      selectedPlan.defaultModel ||
                      t("workspace.settings.apps.agents.planDefaultModel"),
                    plan: selectedPlan.name
                  })
                : t("workspace.settings.apps.agents.generateChoosePlan")}
            </p>
          </div>
          <Button
            disabled={
              generating || !selectedPlan || !draft.harnessAgentTargetId
            }
            size="sm"
            type="button"
            variant="secondary"
            onClick={onGenerate}
          >
            {generating
              ? t("workspace.settings.apps.agents.generating")
              : t("workspace.settings.apps.agents.generate")}
          </Button>
        </div>
        <Textarea
          className={textareaClass}
          placeholder={t(
            "workspace.settings.apps.agents.generationRequirementsPlaceholder"
          )}
          value={draft.generationRequirements}
          onChange={(event) =>
            onUpdate({ generationRequirements: event.currentTarget.value })
          }
        />
        <p className="m-0 text-[10px] leading-[1.3] text-[var(--text-tertiary)]">
          {t("workspace.settings.apps.agents.generateSafetyHint")}
        </p>
      </section>

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.nameLabel")}
          </span>
          <Input
            className={workspaceSettingsInputClass}
            placeholder={t("workspace.settings.apps.agents.namePlaceholder")}
            type="text"
            value={draft.name}
            onChange={(event) => onUpdate({ name: event.currentTarget.value })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.harnessLabel")}
          </span>
          <Select
            value={draft.harnessAgentTargetId || NO_HARNESS_VALUE}
            onValueChange={(value) => {
              if (value === NO_HARNESS_VALUE) {
                return;
              }
              onUpdate({
                defaultModel: "",
                harnessAgentTargetId: value,
                modelPlanId: "",
                modelFallbacks: []
              });
            }}
          >
            <SelectTrigger
              aria-label={t("workspace.settings.apps.agents.harnessLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {harnessOptions.length === 0 ? (
                <SelectItem disabled value={NO_HARNESS_VALUE}>
                  {t("workspace.settings.apps.agents.noHarnesses")}
                </SelectItem>
              ) : null}
              {harnessOptions.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {target.name} · {target.provider}
                  {!target.enabled
                    ? ` · ${t("workspace.settings.apps.agents.disabled")}`
                    : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.modelPlanLabel")}
          </span>
          <Select
            value={selectedPlan?.id ?? NO_PLAN_VALUE}
            onValueChange={(value) => {
              onUpdate({
                defaultModel: "",
                modelPlanId: value === NO_PLAN_VALUE ? "" : value,
                ...(value === NO_PLAN_VALUE ? { modelFallbacks: [] } : {})
              });
            }}
          >
            <SelectTrigger
              aria-label={t("workspace.settings.apps.agents.modelPlanLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              <SelectItem value={NO_PLAN_VALUE}>
                {t("workspace.settings.apps.agents.noModelPlan")}
              </SelectItem>
              {compatiblePlans.map((plan) => (
                <SelectItem key={plan.id} value={plan.id}>
                  {plan.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.defaultModelLabel")}
          </span>
          <Select
            disabled={!selectedPlan || selectedPlan.models.length === 0}
            value={
              selectedPlan?.models.some(
                (model) => model.id === draft.defaultModel
              )
                ? draft.defaultModel
                : PLAN_DEFAULT_MODEL_VALUE
            }
            onValueChange={(value) => {
              onUpdate({
                defaultModel: value === PLAN_DEFAULT_MODEL_VALUE ? "" : value
              });
            }}
          >
            <SelectTrigger
              aria-label={t("workspace.settings.apps.agents.defaultModelLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              <SelectItem value={PLAN_DEFAULT_MODEL_VALUE}>
                {t("workspace.settings.apps.agents.planDefaultModel")}
              </SelectItem>
              {selectedPlan?.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name || model.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <section className="grid gap-2 rounded-[8px] border border-[var(--border-1)] p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-medium text-[var(--text-secondary)]">
              {t("workspace.settings.apps.agents.modelFallbackLabel")}
            </div>
            <p className="m-0 mt-1 text-[11px] leading-[1.4] text-[var(--text-tertiary)]">
              {t("workspace.settings.apps.agents.modelFallbackDescription")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              disabled={
                !draft.modelPlanId ||
                fallbackCandidates.length === 0 ||
                recommendingFallback
              }
              size="sm"
              type="button"
              variant="ghost"
              onClick={onRecommendFallback}
            >
              {recommendingFallback
                ? t("workspace.settings.apps.agents.recommendingModelFallback")
                : t("workspace.settings.apps.agents.recommendModelFallback")}
            </Button>
            <Button
              disabled={!draft.modelPlanId || fallbackCandidates.length === 0}
              size="sm"
              type="button"
              variant="outline"
              onClick={() => {
                const candidate =
                  fallbackCandidates.find(
                    (plan) =>
                      !draft.modelFallbacks.some(
                        (fallback) => fallback.modelPlanId === plan.id
                      )
                  ) ?? fallbackCandidates[0];
                if (!candidate) return;
                onUpdate({
                  modelFallbacks: [
                    ...draft.modelFallbacks,
                    { modelPlanId: candidate.id, model: null }
                  ]
                });
              }}
            >
              {t("workspace.settings.apps.agents.addModelFallback")}
            </Button>
          </div>
        </div>
        {draft.modelFallbacks.map((fallback, index) => {
          const fallbackPlan =
            modelPlans.find((plan) => plan.id === fallback.modelPlanId) ?? null;
          const planOptions = fallbackPlan?.enabled
            ? fallbackCandidates
            : fallbackPlan
              ? [...fallbackCandidates, fallbackPlan]
              : fallbackCandidates;
          return (
            <div
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-center gap-2 max-[640px]:grid-cols-[minmax(0,1fr)_32px]"
              key={`${fallback.modelPlanId}-${index}`}
            >
              <Select
                value={fallback.modelPlanId}
                onValueChange={(modelPlanId) =>
                  updateFallback(index, { modelPlanId, model: null })
                }
              >
                <SelectTrigger className={workspaceSettingsSelectTriggerClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  className={workspaceSettingsSelectContentClass}
                  style={{ zIndex: "var(--z-panel-popover)" }}
                >
                  {planOptions.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={fallback.model || PLAN_DEFAULT_MODEL_VALUE}
                onValueChange={(model) =>
                  updateFallback(index, {
                    model: model === PLAN_DEFAULT_MODEL_VALUE ? null : model
                  })
                }
              >
                <SelectTrigger className={workspaceSettingsSelectTriggerClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  className={workspaceSettingsSelectContentClass}
                  style={{ zIndex: "var(--z-panel-popover)" }}
                >
                  <SelectItem value={PLAN_DEFAULT_MODEL_VALUE}>
                    {t("workspace.settings.apps.agents.planDefaultModel")}
                  </SelectItem>
                  {fallbackPlan?.models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name || model.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                aria-label={t(
                  "workspace.settings.apps.agents.removeModelFallback"
                )}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() =>
                  onUpdate({
                    modelFallbacks: draft.modelFallbacks.filter(
                      (_, fallbackIndex) => fallbackIndex !== index
                    )
                  })
                }
              >
                <DeleteIcon aria-hidden="true" className="size-4" />
              </Button>
            </div>
          );
        })}
      </section>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.agents.purposeLabel")}
        </span>
        <Input
          className={workspaceSettingsInputClass}
          placeholder={t("workspace.settings.apps.agents.purposePlaceholder")}
          type="text"
          value={draft.purpose}
          onChange={(event) => onUpdate({ purpose: event.currentTarget.value })}
        />
      </label>

      <details
        className="group rounded-[8px] border border-[var(--border-1)] p-3"
        open
      >
        <summary className="cursor-pointer text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.agents.behaviorDetailsTitle")}
        </summary>
        <div className="mt-3 grid gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              {t("workspace.settings.apps.agents.instructionsLabel")}
            </span>
            <Textarea
              className={textareaClass}
              placeholder={t(
                "workspace.settings.apps.agents.instructionsPlaceholder"
              )}
              value={draft.instructions}
              onChange={(event) =>
                onUpdate({ instructions: event.currentTarget.value })
              }
            />
          </label>

          <WorkspaceAgentListField
            label={t("workspace.settings.apps.agents.callConditionsLabel")}
            placeholder={t(
              "workspace.settings.apps.agents.callConditionsPlaceholder"
            )}
            value={draft.callConditions}
            onChange={(callConditions) => onUpdate({ callConditions })}
          />
        </div>
      </details>

      <WorkspaceAgentCapabilitySelection
        catalog={capabilityCatalog}
        draft={draft}
        loadFailed={capabilityCatalogLoadFailed}
        loading={capabilityCatalogLoading}
        onRefresh={onRefreshCapabilityCatalog}
        onUpdate={onUpdate}
      />

      <details className="group rounded-[8px] border border-[var(--border-1)] p-3">
        <summary className="cursor-pointer text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.agents.advancedCapabilityIdsTitle")}
        </summary>
        <p className="m-0 mt-2 text-[10px] leading-[1.35] text-[var(--text-tertiary)]">
          {t("workspace.settings.apps.agents.advancedCapabilityIdsDescription")}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-3 max-[760px]:grid-cols-1">
          <WorkspaceAgentListField
            label={t("workspace.settings.apps.agents.skillsLabel")}
            placeholder={t("workspace.settings.apps.agents.skillsPlaceholder")}
            value={draft.skills}
            onChange={(skills) =>
              onUpdate({ capabilitiesExplicit: true, skills })
            }
          />
          <WorkspaceAgentListField
            label={t("workspace.settings.apps.agents.toolsLabel")}
            placeholder={t("workspace.settings.apps.agents.toolsPlaceholder")}
            value={draft.tools}
            onChange={(tools) =>
              onUpdate({ capabilitiesExplicit: true, tools })
            }
          />
          <WorkspaceAgentListField
            label={t("workspace.settings.apps.agents.permissionsLabel")}
            placeholder={t(
              "workspace.settings.apps.agents.permissionsPlaceholder"
            )}
            value={draft.permissions}
            onChange={(permissions) => onUpdate({ permissions })}
          />
        </div>
      </details>

      {draft.generatedAutomationRules.length > 0 ? (
        <section className="grid gap-2 rounded-[8px] border border-[var(--border-1)] p-3">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.generatedRulesTitle")}
          </div>
          <p className="m-0 text-[11px] leading-[1.4] text-[var(--text-tertiary)]">
            {t("workspace.settings.apps.agents.generatedRulesDescription")}
          </p>
          {draft.generatedAutomationRules.map((rule, index) => (
            <div
              key={`${rule.name}-${index}`}
              className="grid gap-1 rounded-[7px] bg-[var(--transparency-block)] p-2"
            >
              <strong className="text-[11px] font-medium text-[var(--text-primary)]">
                {rule.name}
              </strong>
              <span className="text-[10px] text-[var(--text-tertiary)]">
                {t(
                  rule.trigger === "on_task_failed"
                    ? "workspace.settings.apps.automationRules.triggers.onTaskFailed"
                    : "workspace.settings.apps.automationRules.triggers.onTaskComplete"
                )}
                {" · "}
                {t("workspace.settings.apps.automationRules.actions.consult")}
                {" · "}
                {t("workspace.settings.apps.agents.generatedRuleDisabled")}
              </span>
              <span className="text-[10px] leading-[1.35] text-[var(--text-secondary)]">
                {rule.prompt}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          <Switch
            aria-label={t("workspace.settings.apps.agents.enabledLabel")}
            checked={draft.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          {t("workspace.settings.apps.agents.enabledLabel")}
        </label>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={saving} type="button" onClick={onSave}>
            {saving
              ? t("workspace.settings.apps.agents.saving")
              : t("workspace.settings.apps.agents.save")}
          </Button>
        </div>
      </div>

      {feedback ? (
        <p className="m-0 text-[12px] leading-[1.4] text-[var(--state-danger)]">
          {t(
            feedback.kind === "requiredFields"
              ? "workspace.settings.apps.agents.requiredFields"
              : feedback.kind === "generationRequiresPlan"
                ? "workspace.settings.apps.agents.generationRequiresPlan"
                : feedback.kind === "generateFailed"
                  ? "workspace.settings.apps.agents.generateFailed"
                  : feedback.kind === "generatedRulesSaveFailed"
                    ? "workspace.settings.apps.agents.generatedRulesSaveFailed"
                    : feedback.kind === "noRecommendation"
                      ? "workspace.settings.apps.agents.noModelFallbackRecommendation"
                      : feedback.kind === "recommendFailed"
                        ? "workspace.settings.apps.agents.recommendModelFallbackFailed"
                        : "workspace.settings.apps.agents.saveFailed"
          )}
        </p>
      ) : null}
    </section>
  );
}

function WorkspaceAgentListField({
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
        {t("workspace.settings.apps.agents.onePerLine")}
      </span>
    </label>
  );
}
