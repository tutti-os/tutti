import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { modelPlanProtocolForAgentProvider } from "../services/workspaceModelPlanTemplates";
import type {
  WorkspaceAgentModelBinding,
  WorkspaceModelPlan,
  WorkspaceModelPlanBindingTarget
} from "../services/workspaceSettingsTypes";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import {
  workspaceSettingsSelectContentClass,
  workspaceSettingsSelectTriggerClass
} from "./workspaceSettingsFieldStyles";

const NO_PLAN_VALUE = "__no_plan__";
const PLAN_DEFAULT_MODEL_VALUE = "__plan_default__";

/**
 * Per-agent-target model bindings: pick a protocol-compatible plan and an
 * optional default model for each enabled agent target. The first real call
 * an agent makes through a plan completes that plan's verification.
 */
export function WorkspaceAgentModelBindingSection() {
  const { t } = useTranslation();
  const { service, state } = useWorkspaceSettingsService();
  const modelPlans = state.modelPlans;
  const bindings = modelPlans.bindings;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t("workspace.settings.apps.modelPlans.bindings.title")}
        </strong>
        <p className="m-0 text-[13px] leading-[1.35] text-[var(--text-secondary)]">
          {t("workspace.settings.apps.modelPlans.bindings.description")}
        </p>
      </div>

      {bindings.loadFailed ? (
        <p className="m-0 text-[12px] leading-[1.4] text-[var(--state-danger)]">
          {t("workspace.settings.apps.modelPlans.bindings.loadFailed")}
        </p>
      ) : bindings.agentTargets.length === 0 ? (
        <p className="m-0 text-[12px] leading-[1.4] text-[var(--text-tertiary)]">
          {bindings.loading
            ? null
            : t("workspace.settings.apps.modelPlans.bindings.empty")}
        </p>
      ) : (
        <div className="flex w-full flex-col gap-2">
          {bindings.agentTargets.map((target) => (
            <WorkspaceAgentModelBindingRow
              key={target.id}
              binding={
                bindings.bindings.find(
                  (candidate) => candidate.agentTargetId === target.id
                ) ?? null
              }
              plans={modelPlans.plans}
              saveFailed={bindings.saveFailedTargetID === target.id}
              saving={bindings.savingTargetID === target.id}
              target={target}
              onChange={(change) => {
                void service.modelPlans.setAgentBinding(target.id, change);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceAgentModelBindingRow({
  binding,
  plans,
  saveFailed,
  saving,
  target,
  onChange
}: {
  binding: WorkspaceAgentModelBinding | null;
  plans: readonly WorkspaceModelPlan[];
  saveFailed: boolean;
  saving: boolean;
  target: WorkspaceModelPlanBindingTarget;
  onChange: (change: {
    defaultModel?: string | null;
    modelPlanID?: string | null;
  }) => void;
}) {
  const { t } = useTranslation();
  const protocol = modelPlanProtocolForAgentProvider(target.provider);
  const compatiblePlans = protocol
    ? plans.filter((plan) => plan.protocol === protocol && plan.enabled)
    : [];
  const boundPlan =
    (binding?.modelPlanId &&
      compatiblePlans.find((plan) => plan.id === binding.modelPlanId)) ||
    null;

  return (
    <section className="flex w-full flex-col gap-2 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <strong className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">
            {target.name}
          </strong>
          {protocol ? (
            <p className="m-0 mt-0.5 text-[11px] leading-[1.3] text-[var(--text-secondary)]">
              {t(
                protocol === "anthropic"
                  ? "workspace.settings.apps.modelPlans.protocols.anthropic"
                  : "workspace.settings.apps.modelPlans.protocols.openai"
              )}
            </p>
          ) : null}
        </div>
        {protocol === null ? (
          <span className="text-[12px] text-[var(--text-tertiary)]">
            {t("workspace.settings.apps.modelPlans.bindings.unsupported")}
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-[200px] max-[640px]:w-full">
              <Select
                disabled={saving}
                value={boundPlan?.id ?? NO_PLAN_VALUE}
                onValueChange={(value) => {
                  if (value === NO_PLAN_VALUE) {
                    onChange({ defaultModel: null, modelPlanID: null });
                    return;
                  }
                  onChange({ defaultModel: null, modelPlanID: value });
                }}
              >
                <SelectTrigger
                  aria-label={t(
                    "workspace.settings.apps.modelPlans.bindings.planLabel"
                  )}
                  className={workspaceSettingsSelectTriggerClass}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  className={workspaceSettingsSelectContentClass}
                  style={{ zIndex: "var(--z-panel-popover)" }}
                >
                  <SelectItem value={NO_PLAN_VALUE}>
                    {t("workspace.settings.apps.modelPlans.bindings.planNone")}
                  </SelectItem>
                  {compatiblePlans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {boundPlan ? (
              <div className="w-[180px] max-[640px]:w-full">
                <Select
                  disabled={saving || boundPlan.models.length === 0}
                  value={
                    binding?.defaultModel &&
                    boundPlan.models.some(
                      (model) => model.id === binding.defaultModel
                    )
                      ? binding.defaultModel
                      : PLAN_DEFAULT_MODEL_VALUE
                  }
                  onValueChange={(value) => {
                    onChange({
                      defaultModel:
                        value === PLAN_DEFAULT_MODEL_VALUE ? null : value,
                      modelPlanID: boundPlan.id
                    });
                  }}
                >
                  <SelectTrigger
                    aria-label={t(
                      "workspace.settings.apps.modelPlans.bindings.modelLabel"
                    )}
                    className={workspaceSettingsSelectTriggerClass}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    className={workspaceSettingsSelectContentClass}
                    style={{ zIndex: "var(--z-panel-popover)" }}
                  >
                    <SelectItem value={PLAN_DEFAULT_MODEL_VALUE}>
                      {t(
                        "workspace.settings.apps.modelPlans.bindings.planDefault"
                      )}
                    </SelectItem>
                    {boundPlan.models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {saveFailed ? (
        <p className="m-0 text-[12px] leading-[1.4] text-[var(--state-danger)]">
          {t("workspace.settings.apps.modelPlans.bindings.saveFailed")}
        </p>
      ) : null}
    </section>
  );
}
