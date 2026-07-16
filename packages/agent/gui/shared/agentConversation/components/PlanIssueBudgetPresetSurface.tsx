import { Checkbox, Input, Slider } from "@tutti-os/ui-system";
import {
  autoTokenBudget,
  type PlanIssueBudgetPreset
} from "../planImplementationPresentation";

export interface PlanIssueBudgetPresetLabels {
  reasoning: string;
  orchestration: string;
  budgetAuto: string;
  budgetFixed: string;
  tokenBudget: string;
}

export function PlanIssueBudgetPresetSurface({
  disabled,
  labels,
  preset,
  taskCount,
  onChange
}: {
  disabled: boolean;
  labels: PlanIssueBudgetPresetLabels;
  preset: PlanIssueBudgetPreset;
  taskCount: number;
  onChange: (preset: PlanIssueBudgetPreset) => void;
}) {
  const updateExecutionProfile = (
    executionProfile: PlanIssueBudgetPreset["executionProfile"]
  ) => {
    onChange({
      ...preset,
      executionProfile,
      budget: {
        ...preset.budget,
        tokenLimit:
          preset.budget.mode === "auto"
            ? autoTokenBudget(taskCount, executionProfile)
            : preset.budget.tokenLimit
      }
    });
  };

  return (
    <div className="grid gap-3">
      <IntensityField
        disabled={disabled}
        label={labels.reasoning}
        value={preset.executionProfile.reasoningIntensity}
        onChange={(value) =>
          updateExecutionProfile({
            ...preset.executionProfile,
            reasoningIntensity: value
          })
        }
      />
      <IntensityField
        disabled={disabled}
        label={labels.orchestration}
        value={preset.executionProfile.orchestrationIntensity}
        onChange={(value) =>
          updateExecutionProfile({
            ...preset.executionProfile,
            orchestrationIntensity: value
          })
        }
      />
      <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
        <Checkbox
          checked={preset.budget.mode === "auto"}
          disabled={disabled}
          onCheckedChange={(checked) => {
            const mode = checked === true ? "auto" : "fixed";
            onChange({
              ...preset,
              budget: {
                ...preset.budget,
                mode,
                tokenLimit:
                  mode === "auto"
                    ? autoTokenBudget(taskCount, preset.executionProfile)
                    : Math.max(1, preset.budget.tokenLimit)
              }
            });
          }}
        />
        {preset.budget.mode === "auto" ? labels.budgetAuto : labels.budgetFixed}
      </label>
      <label className="grid gap-1 text-[12px] text-[var(--text-secondary)]">
        <span>{labels.tokenBudget}</span>
        <Input
          disabled={disabled || preset.budget.mode === "auto"}
          min={1}
          type="number"
          value={preset.budget.tokenLimit}
          onChange={(event) =>
            onChange({
              ...preset,
              budget: {
                ...preset.budget,
                tokenLimit: Math.max(
                  1,
                  Number.parseInt(event.currentTarget.value, 10) || 1
                )
              }
            })
          }
        />
      </label>
    </div>
  );
}

function IntensityField({
  disabled,
  label,
  value,
  onChange
}: {
  disabled: boolean;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1 text-[12px] text-[var(--text-secondary)]">
      <span>
        {label}: {value}
      </span>
      <Slider
        aria-label={label}
        disabled={disabled}
        max={100}
        min={0}
        value={[value]}
        onValueChange={(values) => onChange(values[0] ?? value)}
      />
    </label>
  );
}
