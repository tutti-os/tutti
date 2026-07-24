import {
  Button,
  CloseIcon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { workspaceAgentCompatibleModelPlans } from "../services/workspaceAgentModelPlans";
import { modelPlanProtocolForAgentProvider } from "../services/workspaceModelPlanTemplates";
import type {
  WorkspaceAgentDefinition,
  WorkspaceAgentDraft,
  WorkspaceAgentFeedback,
  WorkspaceAgentHarnessTargetOption,
  WorkspaceModelPlan
} from "../services/workspaceSettingsTypes";

const NO_HARNESS_VALUE = "__no_harness__";
const NO_PLAN_VALUE = "__no_plan__";
const PLAN_DEFAULT_MODEL_VALUE = "__plan_default__";

/**
 * Simplified Agent editor: name, Agent Runtime, model plan + default model,
 * description, and behavior text. Dormant contract fields (failover chain,
 * capability allowlists) have no surface here; the draft passes their stored
 * values through so saving never clears them.
 */
export function WorkspaceAgentEditor({
  agent,
  draft,
  feedback,
  harnessTargets,
  modelPlans,
  saving,
  onCancel,
  onSave,
  onUpdate
}: {
  agent: WorkspaceAgentDefinition | null;
  draft: Readonly<WorkspaceAgentDraft>;
  feedback: WorkspaceAgentFeedback | null;
  harnessTargets: readonly WorkspaceAgentHarnessTargetOption[];
  modelPlans: readonly WorkspaceModelPlan[];
  saving: boolean;
  onCancel: () => void;
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
  const compatiblePlans = workspaceAgentCompatibleModelPlans(
    modelPlans,
    protocol,
    draft.modelPlanId
  );
  const selectedPlan =
    compatiblePlans.find((plan) => plan.id === draft.modelPlanId) ?? null;
  const editing = draft.agentId !== null;

  return (
    <section className="flex w-full flex-col gap-4 rounded-[6px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
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

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.nameLabel")}
          </span>
          <Input
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
                modelPlanId: ""
              });
            }}
          >
            <SelectTrigger
              aria-label={t("workspace.settings.apps.agents.harnessLabel")}
              className="w-full rounded-[6px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={{ zIndex: "var(--z-panel-popover)" }}>
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
                modelPlanId: value === NO_PLAN_VALUE ? "" : value
              });
            }}
          >
            <SelectTrigger
              aria-label={t("workspace.settings.apps.agents.modelPlanLabel")}
              className="w-full rounded-[6px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={{ zIndex: "var(--z-panel-popover)" }}>
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
              className="w-full rounded-[6px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={{ zIndex: "var(--z-panel-popover)" }}>
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

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {t("workspace.settings.apps.agents.descriptionLabel")}
        </span>
        <Input
          placeholder={t(
            "workspace.settings.apps.agents.descriptionPlaceholder"
          )}
          type="text"
          value={draft.description}
          onChange={(event) =>
            onUpdate({ description: event.currentTarget.value })
          }
        />
      </label>

      <div className="grid gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.instructionsLabel")}
          </span>
          <Textarea
            placeholder={t(
              "workspace.settings.apps.agents.instructionsPlaceholder"
            )}
            value={draft.instructions}
            onChange={(event) =>
              onUpdate({ instructions: event.currentTarget.value })
            }
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.agents.callConditionsLabel")}
          </span>
          <Textarea
            placeholder={t(
              "workspace.settings.apps.agents.callConditionsPlaceholder"
            )}
            value={draft.callConditions}
            onChange={(event) =>
              onUpdate({ callConditions: event.currentTarget.value })
            }
          />
          <span className="text-[10px] leading-[1.3] text-[var(--text-tertiary)]">
            {t("workspace.settings.apps.agents.onePerLine")}
          </span>
        </label>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button disabled={saving} type="button" onClick={onSave}>
          {saving
            ? t("workspace.settings.apps.agents.saving")
            : t("workspace.settings.apps.agents.save")}
        </Button>
      </div>

      {feedback ? (
        <p className="m-0 text-[12px] leading-[1.4] text-[var(--state-danger)]">
          {t(
            feedback.kind === "requiredFields"
              ? "workspace.settings.apps.agents.requiredFields"
              : "workspace.settings.apps.agents.saveFailed"
          )}
        </p>
      ) : null}
    </section>
  );
}
