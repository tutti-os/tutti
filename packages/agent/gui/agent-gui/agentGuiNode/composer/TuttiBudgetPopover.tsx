import { useState, type ReactNode } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider
} from "@tutti-os/ui-system";
import tuttiIntensityHandleBalanceUrl from "../../../app/renderer/assets/icons/tutti-intensity-handle-balance.png";
import tuttiIntensityHandleCostUrl from "../../../app/renderer/assets/icons/tutti-intensity-handle-cost.png";
import tuttiIntensityHandlePowerfulUrl from "../../../app/renderer/assets/icons/tutti-intensity-handle-powerful.png";
import {
  projectTuttiPreferencePreview,
  type TuttiPreferenceTier
} from "./tuttiIntensityPreview";
import { TuttiBudgetPad } from "./TuttiBudgetPad";

export interface TuttiBudgetPopoverLabels {
  title: string;
  effectLabel: string;
  speedLabel: string;
  previewHint: string;
  previewCost: string;
  previewBalance: string;
  previewPowerful: string;
  modelPreferenceLabel: string;
  modelPreferenceCost: string;
  modelPreferenceBalance: string;
  modelPreferencePowerful: string;
  parallelismLabel: string;
  parallelismValue(count: number): string;
}

const tierTone: Record<
  TuttiPreferenceTier,
  {
    sliderHandleUrl: string;
    valueClassName: string;
  }
> = {
  cost: {
    sliderHandleUrl: tuttiIntensityHandleCostUrl,
    valueClassName: "text-[var(--state-success)]"
  },
  balance: {
    sliderHandleUrl: tuttiIntensityHandleBalanceUrl,
    valueClassName: "text-[var(--accent-codex)]"
  },
  powerful: {
    sliderHandleUrl: tuttiIntensityHandlePowerfulUrl,
    valueClassName: "text-[var(--tutti-purple)]"
  }
};

/**
 * Keyboard and assistive-tech control for the 2D pad: one visually hidden
 * Radix slider per axis. Pointer interaction lives on the pad itself.
 */
function HiddenAxisSlider({
  kind,
  label,
  value,
  onChange
}: {
  kind: "effect" | "speed";
  label: string;
  value: number;
  onChange(value: number): void;
}): React.JSX.Element {
  return (
    <div className="sr-only">
      <Slider
        aria-label={label}
        data-agent-tutti-preference-slider={kind}
        max={100}
        min={0}
        step={1}
        value={[value]}
        onValueChange={(values) => onChange(values[0] ?? value)}
      />
    </div>
  );
}

export function TuttiBudgetPopover({
  children,
  effect,
  speed,
  labels,
  onEffectChange,
  onSpeedChange
}: {
  children: ReactNode;
  effect: number;
  speed: number;
  labels: TuttiBudgetPopoverLabels;
  onEffectChange(value: number): void;
  onSpeedChange(value: number): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [draftEffect, setDraftEffect] = useState(effect);
  const [draftSpeed, setDraftSpeed] = useState(speed);
  const preview = projectTuttiPreferencePreview(draftEffect, draftSpeed);
  const previewTone = tierTone[preview.effectTier];
  const modelPreference = {
    economical: labels.modelPreferenceCost,
    balanced: labels.modelPreferenceBalance,
    mostCapable: labels.modelPreferencePowerful
  }[preview.modelPreference];
  const parallelismValue = labels.parallelismValue(preview.parallelTarget);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setDraftEffect(effect);
          setDraftSpeed(speed);
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="nodrag rounded-[12px]"
        data-agent-tutti-budget-popover="true"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
      >
        <div className="text-[13px] font-semibold text-[var(--text-primary)]">
          {labels.title}
        </div>
        <div
          className="group"
          data-agent-tutti-effect-tier={preview.effectTier}
          data-agent-tutti-speed-tier={preview.speedTier}
        >
          <TuttiBudgetPad
            effect={draftEffect}
            speed={draftSpeed}
            effectLabel={labels.effectLabel}
            speedLabel={labels.speedLabel}
            handleUrl={tierTone[preview.effectTier].sliderHandleUrl}
            onChange={(next) => {
              if (next.effect !== draftEffect) {
                setDraftEffect(next.effect);
                onEffectChange(next.effect);
              }
              if (next.speed !== draftSpeed) {
                setDraftSpeed(next.speed);
                onSpeedChange(next.speed);
              }
            }}
          />
          <HiddenAxisSlider
            kind="effect"
            label={labels.effectLabel}
            value={draftEffect}
            onChange={(next) => {
              setDraftEffect(next);
              onEffectChange(next);
            }}
          />
          <HiddenAxisSlider
            kind="speed"
            label={labels.speedLabel}
            value={draftSpeed}
            onChange={(next) => {
              setDraftSpeed(next);
              onSpeedChange(next);
            }}
          />
        </div>
        <div aria-live="polite" className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="min-w-0">
            <div className="text-[var(--text-tertiary)]">
              {labels.modelPreferenceLabel}
            </div>
            <div
              className={`whitespace-nowrap text-[13px] font-medium ${previewTone.valueClassName}`}
              data-agent-tutti-budget-model-preference="true"
            >
              {modelPreference}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[var(--text-tertiary)]">
              {labels.parallelismLabel}
            </div>
            <div
              className="whitespace-nowrap text-[13px] font-medium text-[var(--text-primary)]"
              data-agent-tutti-budget-parallelism="true"
            >
              {parallelismValue}
            </div>
          </div>
        </div>
        <p className="mb-0 text-[11px] leading-[1.35] text-[var(--text-tertiary)]">
          {labels.previewHint}
        </p>
      </PopoverContent>
    </Popover>
  );
}
