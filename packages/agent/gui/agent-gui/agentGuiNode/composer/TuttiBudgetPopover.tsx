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
  projectTuttiIntensityPreview,
  type TuttiIntensityTier
} from "./tuttiIntensityPreview";

export interface TuttiBudgetPopoverLabels {
  title: string;
  intensityLabel: string;
  previewTitle: string;
  previewHint: string;
  previewCost: string;
  previewBalance: string;
  previewPowerful: string;
  modelStrengthLabel: string;
  modelStrengthCost: string;
  modelStrengthBalance: string;
  modelStrengthPowerful: string;
  agentCountLabel: string;
  agentCountCost: string;
  agentCountBalance: string;
  agentCountPowerful: string;
}

const tierTone: Record<
  TuttiIntensityTier,
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
 * Modal-like Tutti budget popup anchored to the composer's Tutti chip.
 *
 * Slider movement applies immediately through `onChange` -- there is no
 * confirm/cancel step. The local draft only keeps the thumb smooth while the
 * caller propagates the new value, and is reseeded from the effective value
 * on every open. Escape settles inside the popup (close + preventDefault) so
 * it cannot leak into surrounding composer containers -- same contract as the
 * confirmation-dialog precedent in
 * packages/ui/system/src/components/confirmation-dialog/confirmation-dialog.tsx.
 */
export function TuttiBudgetPopover({
  children,
  intensity,
  labels,
  onChange
}: {
  /** Trigger chip; rendered through `PopoverTrigger asChild`. */
  children: ReactNode;
  /** Effective orchestration intensity (0-100) used to seed the draft. */
  intensity: number;
  labels: TuttiBudgetPopoverLabels;
  onChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftIntensity, setDraftIntensity] = useState(intensity);
  const preview = projectTuttiIntensityPreview(draftIntensity);
  const previewTone = tierTone[preview.tier];
  const modelStrength = {
    economical: labels.modelStrengthCost,
    balanced: labels.modelStrengthBalance,
    mostCapable: labels.modelStrengthPowerful
  }[preview.modelStrength];
  const agentCount = {
    single: labels.agentCountCost,
    smallGroup: labels.agentCountBalance,
    maxParallel: labels.agentCountPowerful
  }[preview.agentCount];
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setDraftIntensity(intensity);
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      {/*
        `nodrag` is load-bearing: the workbench WorkspaceNodeWindow stops
        click propagation (onClickCapture) for any click target outside a
        `.nodrag` subtree. This content is portaled to document.body, so
        without the class every button click inside the popup is killed
        before React's bubble handlers run (P1: confirm silently no-ops).
      */}
      <PopoverContent
        align="start"
        className="nodrag"
        data-agent-tutti-budget-popover="true"
        onEscapeKeyDown={(event) => {
          // Escape closes only this popup: prevent the dismissable-layer
          // default so no other container reacts, then close ourselves.
          event.preventDefault();
          setOpen(false);
        }}
      >
        <div className="text-[13px] font-semibold text-[var(--text-primary)]">
          {labels.title}
        </div>
        <div
          className="rounded-[8px] border border-[var(--line-2)] bg-[var(--transparency-block)] p-2.5"
          data-agent-tutti-budget-preview={preview.tier}
        >
          <div className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-secondary)]">
            <span>{labels.intensityLabel}</span>
            <span
              className="text-[var(--text-primary)] tabular-nums"
              data-agent-tutti-budget-intensity-value="true"
            >
              {draftIntensity}
            </span>
          </div>
          <div className="mt-3">
            <Slider
              aria-label={labels.intensityLabel}
              className={`-mx-1 w-[calc(100%_+_8px)] [&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-track]]:mx-1 [&_[data-slot=slider-track]]:h-5 [&_[data-slot=slider-track]]:bg-[linear-gradient(90deg,var(--state-success)_0%,var(--accent-codex)_50%,var(--tutti-purple)_100%)] [&_[data-slot=slider-thumb]]:size-10 [&_[data-slot=slider-thumb]]:border-transparent [&_[data-slot=slider-thumb]]:bg-transparent [&_[data-slot=slider-thumb]]:bg-[image:var(--tutti-intensity-handle-url)] [&_[data-slot=slider-thumb]]:bg-contain [&_[data-slot=slider-thumb]]:bg-center [&_[data-slot=slider-thumb]]:bg-no-repeat [&_[data-slot=slider-thumb]]:shadow-none [&_[data-slot=slider-thumb]]:hover:ring-0 [&_[data-slot=slider-thumb]]:focus-visible:ring-0 [&_[data-slot=slider-thumb]]:-translate-y-1 [&_[data-slot=slider-thumb]]:cursor-grab [&_[data-slot=slider-thumb]]:active:cursor-grabbing`}
              style={
                {
                  "--tutti-intensity-handle-url": `url("${previewTone.sliderHandleUrl}")`
                } as CSSProperties
              }
              data-agent-tutti-budget-intensity-slider="true"
              data-agent-tutti-budget-slider-tone={preview.tier}
              max={100}
              min={0}
              step={1}
              value={[draftIntensity]}
              onValueChange={(values) => {
                const next = values[0] ?? draftIntensity;
                setDraftIntensity(next);
                onChange(next);
              }}
            />
            <div className="mt-3 flex items-center justify-between gap-2 text-[11px] font-medium">
              <span className="text-[var(--state-success)]">
                {labels.previewCost}
              </span>
              <span className="text-[var(--accent-codex)]">
                {labels.previewBalance}
              </span>
              <span className="text-[var(--tutti-purple)]">
                {labels.previewPowerful}
              </span>
            </div>
          </div>
          <div
            aria-live="polite"
            className="mt-2 border-t border-[var(--line-2)] pt-2"
          >
            <span className="text-[12px] font-medium text-[var(--text-secondary)]">
              {labels.previewTitle}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
            <div className="min-w-0">
              <div className="text-[var(--text-tertiary)]">
                {labels.modelStrengthLabel}
              </div>
              <div
                className={`truncate text-[13px] font-medium ${previewTone.valueClassName}`}
                data-agent-tutti-budget-model-strength="true"
              >
                {modelStrength}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[var(--text-tertiary)]">
                {labels.agentCountLabel}
              </div>
              <div
                className="truncate text-[13px] font-medium text-[var(--text-primary)]"
                data-agent-tutti-budget-agent-count="true"
              >
                {agentCount}
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
