import type { JSX } from "react";
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch
} from "@tutti-os/ui-system";
import type { IssueManagerController } from "../../react/index.ts";

const unassignedValue = "__unassigned__";

export function IssueManagerExecutionProfileFields({
  controller
}: {
  controller: IssueManagerController;
}): JSX.Element | null {
  if (!controller.isTuttiModePlanIssue) {
    return null;
  }

  const profile = controller.issueDraft.executionProfile ?? {
    orchestrationIntensity: 50,
    reasoningIntensity: 50
  };
  const budget = controller.issueDraft.budget ?? {
    consumedTokens: 0,
    mode: "auto" as const,
    quotaWaterlinePercent: 10,
    status: "active" as const,
    tokenLimit: 0
  };
  const setIntensity = (
    field: "orchestrationIntensity" | "reasoningIntensity",
    value: number
  ) => {
    controller.setIssueDraft({
      executionProfile: {
        ...profile,
        [field]: Math.max(0, Math.min(100, Math.round(value)))
      }
    });
  };

  return (
    <section className="grid gap-4 rounded-[12px] border border-[var(--line-2)] p-4">
      <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
        {controller.copy.t("labels.executionProfile")}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <IntensitySliderField
          label={controller.copy.t("labels.reasoningIntensity")}
          value={profile.reasoningIntensity}
          onChange={(value) => setIntensity("reasoningIntensity", value)}
        />
        <IntensitySliderField
          label={controller.copy.t("labels.orchestrationIntensity")}
          value={profile.orchestrationIntensity}
          onChange={(value) => setIntensity("orchestrationIntensity", value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-[13px] font-semibold text-[var(--text-secondary)]">
          <span>{controller.copy.t("labels.budgetMode")}</span>
          <Select
            value={budget.mode}
            onValueChange={(mode: "auto" | "fixed") => {
              controller.setIssueDraft({
                budget: {
                  ...budget,
                  mode,
                  status: "active",
                  tokenLimit:
                    mode === "fixed" && budget.tokenLimit <= 0
                      ? 100_000
                      : budget.tokenLimit
                }
              });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                {controller.copy.t("labels.budgetAuto")}
              </SelectItem>
              <SelectItem value="fixed">
                {controller.copy.t("labels.budgetFixed")}
              </SelectItem>
            </SelectContent>
          </Select>
        </label>
        <NumberField
          disabled={budget.mode === "auto"}
          label={controller.copy.t("labels.tokenBudget")}
          min={1}
          value={budget.tokenLimit}
          onChange={(raw) => {
            controller.setIssueDraft({
              budget: {
                ...budget,
                tokenLimit: Math.max(0, Number.parseInt(raw, 10) || 0)
              }
            });
          }}
        />
      </div>
      <NumberField
        label={controller.copy.t("labels.quotaWaterline")}
        max={100}
        min={0}
        value={budget.quotaWaterlinePercent}
        onChange={(raw) => {
          controller.setIssueDraft({
            budget: {
              ...budget,
              quotaWaterlinePercent: clampIntensity(raw)
            }
          });
        }}
      />
      <label className="flex items-start justify-between gap-4 rounded-[10px] border border-[var(--line-2)] px-3 py-2.5 text-[13px] text-[var(--text-secondary)]">
        <span className="grid gap-1">
          <span className="font-semibold">
            {controller.copy.t("labels.dispatchPaused")}
          </span>
          <span className="text-[11px] font-normal text-[var(--text-tertiary)]">
            {controller.copy.t("labels.dispatchPausedDescription")}
          </span>
        </span>
        <Switch
          aria-label={controller.copy.t("labels.dispatchPaused")}
          checked={controller.issueDraft.dispatchPaused ?? false}
          onCheckedChange={(dispatchPaused) =>
            controller.setIssueDraft({ dispatchPaused })
          }
        />
      </label>
      {controller.issueEditorMode === "edit" &&
      controller.issueDraft.dispatchPaused &&
      controller.issueDetail.value?.issue.budget?.status === "soft_limited" ? (
        <p className="m-0 rounded-[10px] border border-[var(--color-warning)] bg-[var(--background-secondary)] px-3 py-2.5 text-[12px] leading-5 text-[var(--text-secondary)]">
          {controller.copy.t("labels.budgetRecoveryRearrangeHint")}
        </p>
      ) : null}
    </section>
  );
}

function IntensitySliderField({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className="grid gap-2 text-[13px] font-semibold text-[var(--text-secondary)]">
      <span>
        {label}: {value}
      </span>
      <Slider
        aria-label={label}
        max={100}
        min={0}
        value={[value]}
        onValueChange={(values) => onChange(values[0] ?? value)}
      />
    </label>
  );
}

export function IssueManagerTaskAssignmentFields({
  controller
}: {
  controller: IssueManagerController;
}): JSX.Element | null {
  if (!controller.isTuttiModePlanIssue) {
    return null;
  }

  const draft = controller.taskDraft;
  const selectedAgentTargetId = draft.agentTargetId?.trim() || unassignedValue;
  const selectedAgent = controller.agentTargetOptions.find(
    (option) => option.agentTargetId === draft.agentTargetId
  );
  const compatibleModelPlans = (controller.modelPlanOptions ?? []).filter(
    (plan) =>
      !selectedAgent?.modelPlanProtocol ||
      plan.protocol === selectedAgent.modelPlanProtocol
  );
  const selectedModelPlan = compatibleModelPlans.find(
    (plan) => plan.id === draft.modelPlanId
  );

  return (
    <section className="grid gap-4 rounded-[12px] border border-[var(--line-2)] p-4">
      <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
        {controller.copy.t("labels.executionAssignment")}
      </h3>
      <label className="grid gap-2 text-[13px] font-semibold text-[var(--text-secondary)]">
        <span>{controller.copy.t("labels.agent")}</span>
        <Select
          value={selectedAgentTargetId}
          onValueChange={(value) => {
            const agentTargetId = value === unassignedValue ? "" : value;
            const nextAgent = controller.agentTargetOptions.find(
              (option) => option.agentTargetId === agentTargetId
            );
            const currentPlan = (controller.modelPlanOptions ?? []).find(
              (plan) => plan.id === draft.modelPlanId
            );
            const planRemainsCompatible = Boolean(
              currentPlan &&
              (!nextAgent?.modelPlanProtocol ||
                currentPlan.protocol === nextAgent.modelPlanProtocol)
            );
            controller.setTaskDraft({
              agentTargetId,
              ...(!planRemainsCompatible ? { modelPlanId: "", model: "" } : {})
            });
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={unassignedValue}>
              {controller.copy.t("labels.unassigned")}
            </SelectItem>
            {controller.agentTargetOptions
              .filter((option) => option.agentTargetId?.trim())
              .map((option) => (
                <SelectItem
                  disabled={option.disabled === true}
                  key={option.agentTargetId}
                  value={option.agentTargetId!}
                >
                  {option.label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        {controller.modelPlanOptions &&
        controller.modelPlanOptions.length > 0 ? (
          <>
            <AssignmentSelectField
              label={controller.copy.t("labels.modelPlan")}
              unassigned={controller.copy.t("labels.unassigned")}
              value={draft.modelPlanId}
              options={compatibleModelPlans.map((plan) => ({
                label: plan.name,
                value: plan.id
              }))}
              onChange={(modelPlanId) => {
                const plan = compatibleModelPlans.find(
                  (candidate) => candidate.id === modelPlanId
                );
                controller.setTaskDraft({
                  modelPlanId: modelPlanId ?? "",
                  model: plan?.models.some((model) => model.id === draft.model)
                    ? draft.model
                    : (plan?.defaultModel ?? "")
                });
              }}
            />
            <AssignmentSelectField
              disabled={!selectedModelPlan}
              label={controller.copy.t("labels.model")}
              unassigned={controller.copy.t("labels.unassigned")}
              value={
                selectedModelPlan?.models.some(
                  (model) => model.id === draft.model
                )
                  ? draft.model
                  : undefined
              }
              options={(selectedModelPlan?.models ?? []).map((model) => ({
                label: model.tier
                  ? `${model.name} · ${model.tier}`
                  : model.name,
                value: model.id
              }))}
              onChange={(model) =>
                controller.setTaskDraft({ model: model ?? "" })
              }
            />
          </>
        ) : (
          <>
            <TextField
              label={controller.copy.t("labels.modelPlan")}
              placeholder={controller.copy.t("composer.modelPlanPlaceholder")}
              value={draft.modelPlanId ?? ""}
              onChange={(modelPlanId) =>
                controller.setTaskDraft({ modelPlanId })
              }
            />
            <TextField
              label={controller.copy.t("labels.model")}
              placeholder={controller.copy.t("composer.modelPlaceholder")}
              value={draft.model ?? ""}
              onChange={(model) => controller.setTaskDraft({ model })}
            />
          </>
        )}
      </div>
      <TextField
        label={controller.copy.t("labels.executionDirectory")}
        placeholder={controller.copy.t(
          "composer.executionDirectoryPlaceholder"
        )}
        value={draft.executionDirectory ?? ""}
        onChange={(executionDirectory) =>
          controller.setTaskDraft({ executionDirectory })
        }
      />
      <TextField
        label={controller.copy.t("labels.dependencies")}
        placeholder={controller.copy.t("composer.dependenciesPlaceholder")}
        value={(draft.dependencyTaskIds ?? []).join(", ")}
        onChange={(value) =>
          controller.setTaskDraft({
            dependencyTaskIds: value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          })
        }
      />
    </section>
  );
}

function AssignmentSelectField({
  disabled,
  label,
  options,
  unassigned,
  value,
  onChange
}: {
  disabled?: boolean;
  label: string;
  options: Array<{ label: string; value: string }>;
  unassigned: string;
  value?: string;
  onChange: (value: string | undefined) => void;
}): JSX.Element {
  return (
    <label className="grid gap-2 text-[13px] font-semibold text-[var(--text-secondary)]">
      <span>{label}</span>
      <Select
        disabled={disabled}
        value={value?.trim() || unassignedValue}
        onValueChange={(nextValue) =>
          onChange(nextValue === unassignedValue ? undefined : nextValue)
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={unassignedValue}>{unassigned}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function NumberField({
  disabled,
  label,
  max,
  min,
  onChange,
  value
}: {
  disabled?: boolean;
  label: string;
  max?: number;
  min?: number;
  onChange: (value: string) => void;
  value: number;
}): JSX.Element {
  return (
    <label className="grid gap-2 text-[13px] font-semibold text-[var(--text-secondary)]">
      <span>{label}</span>
      <Input
        disabled={disabled}
        max={max}
        min={min}
        type="number"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function TextField({
  label,
  onChange,
  placeholder,
  value
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}): JSX.Element {
  return (
    <label className="grid gap-2 text-[13px] font-semibold text-[var(--text-secondary)]">
      <span>{label}</span>
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function clampIntensity(raw: string): number {
  return Math.min(100, Math.max(0, Number.parseInt(raw, 10) || 0));
}
