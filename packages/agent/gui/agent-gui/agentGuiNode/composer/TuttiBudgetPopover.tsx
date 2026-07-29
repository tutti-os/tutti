import { useState, type CSSProperties, type ReactNode } from "react";
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
import { TuttiIntensityStarStream } from "./TuttiIntensityStarStream";

export interface TuttiBudgetPopoverLabels {
  title: string;
  effectLabel: string;
  speedLabel: string;
  previewTitle: string;
  previewHint: string;
  previewCost: string;
  previewBalance: string;
  previewPowerful: string;
  modelPreferenceLabel: string;
  modelPreferenceCost: string;
  modelPreferenceBalance: string;
  modelPreferencePowerful: string;
  modelPreferenceFastestSuitable: string;
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

function PreferenceSlider({
  kind,
  label,
  value,
  tier,
  onChange,
  stars
}: {
  kind: "effect" | "speed";
  label: string;
  value: number;
  tier: TuttiPreferenceTier;
  onChange(value: number): void;
  stars: boolean;
}): React.JSX.Element {
  const tone = tierTone[tier];
  return (
    <div data-agent-tutti-preference={kind}>
      <div className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-secondary)]">
        <span>{label}</span>
        <span className="text-[var(--text-primary)] tabular-nums">{value}</span>
      </div>
      <div className="relative mt-2">
        {stars ? (
          <TuttiIntensityStarStream intensity={value} tier={tier} />
        ) : null}
        <Slider
          aria-label={label}
          className="-mx-1 w-[calc(100%_+_8px)] [&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-track]]:mx-1 [&_[data-slot=slider-track]]:h-5 [&_[data-slot=slider-track]]:bg-[linear-gradient(color-mix(in_srgb,var(--white-stationary)_20%,transparent),color-mix(in_srgb,var(--white-stationary)_20%,transparent)),linear-gradient(90deg,var(--state-success)_0%,var(--accent-codex)_50%,var(--tutti-purple)_100%)] [&_[data-slot=slider-thumb]]:size-10 [&_[data-slot=slider-thumb]]:border-transparent [&_[data-slot=slider-thumb]]:bg-transparent [&_[data-slot=slider-thumb]]:bg-[image:var(--tutti-intensity-handle-url)] [&_[data-slot=slider-thumb]]:bg-contain [&_[data-slot=slider-thumb]]:bg-center [&_[data-slot=slider-thumb]]:bg-no-repeat [&_[data-slot=slider-thumb]]:shadow-none [&_[data-slot=slider-thumb]]:hover:ring-0 [&_[data-slot=slider-thumb]]:focus-visible:ring-0 [&_[data-slot=slider-thumb]]:-translate-y-1 [&_[data-slot=slider-thumb]]:cursor-grab [&_[data-slot=slider-thumb]]:active:cursor-grabbing [&_[data-slot=slider-thumb]]:z-[2]"
          style={
            {
              "--tutti-intensity-handle-url": `url("${tone.sliderHandleUrl}")`
            } as CSSProperties
          }
          data-agent-tutti-preference-slider={kind}
          data-agent-tutti-budget-slider-tone={tier}
          max={100}
          min={0}
          step={1}
          value={[value]}
          onValueChange={(values) => onChange(values[0] ?? value)}
        />
      </div>
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
    mostCapable: labels.modelPreferencePowerful,
    fastestSuitable: labels.modelPreferenceFastestSuitable
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
        className="nodrag"
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
          className="mt-2 rounded-[8px] border border-[var(--line-2)] bg-[var(--transparency-block)] p-2.5"
          data-agent-tutti-effect-tier={preview.effectTier}
          data-agent-tutti-speed-tier={preview.speedTier}
        >
          <div className="space-y-4">
            <PreferenceSlider
              kind="effect"
              label={labels.effectLabel}
              value={draftEffect}
              tier={preview.effectTier}
              stars={true}
              onChange={(next) => {
                setDraftEffect(next);
                onEffectChange(next);
              }}
            />
            <PreferenceSlider
              kind="speed"
              label={labels.speedLabel}
              value={draftSpeed}
              tier={preview.speedTier}
              stars={false}
              onChange={(next) => {
                setDraftSpeed(next);
                onSpeedChange(next);
              }}
            />
          </div>
          <div
            aria-live="polite"
            className="mt-3 border-t border-[var(--line-2)] pt-2"
          >
            <span className="text-[12px] font-medium text-[var(--text-secondary)]">
              {labels.previewTitle}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
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
          <p className="mt-2 mb-0 text-[11px] leading-[1.35] text-[var(--text-tertiary)]">
            {labels.previewHint}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
