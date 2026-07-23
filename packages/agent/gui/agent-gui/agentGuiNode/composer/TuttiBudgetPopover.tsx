import { useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider
} from "@tutti-os/ui-system";
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
  confirm: string;
  cancel: string;
}

const tierTone: Record<
  TuttiIntensityTier,
  {
    badgeVariant: "success" | "warning" | "pending";
    sliderClassName: string;
  }
> = {
  cost: {
    badgeVariant: "success",
    sliderClassName:
      "[&_[data-slot=slider-thumb]]:border-[var(--state-success)]"
  },
  balance: {
    badgeVariant: "warning",
    sliderClassName:
      "[&_[data-slot=slider-thumb]]:border-[var(--state-warning)]"
  },
  powerful: {
    badgeVariant: "pending",
    sliderClassName: "[&_[data-slot=slider-thumb]]:border-[var(--tutti-purple)]"
  }
};

/**
 * Modal-like Tutti budget popup anchored to the composer's Tutti chip.
 *
 * The popup edits a local orchestration-intensity draft seeded from the
 * effective value on open; only Confirm commits it via `onConfirm`. Outside
 * clicks never dismiss it, and Escape settles inside the popup (close +
 * preventDefault) so it cannot leak into surrounding composer containers --
 * same contract as the confirmation-dialog precedent in
 * packages/ui/system/src/components/confirmation-dialog/confirmation-dialog.tsx.
 */
export function TuttiBudgetPopover({
  children,
  intensity,
  labels,
  onConfirm
}: {
  /** Trigger chip; rendered through `PopoverTrigger asChild`. */
  children: ReactNode;
  /** Effective orchestration intensity (0-100) used to seed the draft. */
  intensity: number;
  labels: TuttiBudgetPopoverLabels;
  onConfirm: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftIntensity, setDraftIntensity] = useState(intensity);
  const preview = projectTuttiIntensityPreview(draftIntensity);
  const previewTone = tierTone[preview.tier];
  const previewLabel = {
    cost: labels.previewCost,
    balance: labels.previewBalance,
    powerful: labels.previewPowerful
  }[preview.tier];
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
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
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
          <div className="mt-2">
            <Slider
              aria-label={labels.intensityLabel}
              className={`[&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-track]]:bg-[linear-gradient(90deg,var(--state-success)_0%,var(--state-warning)_50%,var(--tutti-purple)_100%)] ${previewTone.sliderClassName}`}
              data-agent-tutti-budget-intensity-slider="true"
              data-agent-tutti-budget-slider-tone={preview.tier}
              max={100}
              min={0}
              step={1}
              value={[draftIntensity]}
              onValueChange={(values) =>
                setDraftIntensity(values[0] ?? draftIntensity)
              }
            />
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] font-medium">
              <span className="text-[var(--state-success)]">
                {labels.previewCost}
              </span>
              <span className="text-[var(--state-warning)]">
                {labels.previewBalance}
              </span>
              <span className="text-[var(--tutti-purple)]">
                {labels.previewPowerful}
              </span>
            </div>
          </div>
          <div
            aria-live="polite"
            className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--line-2)] pt-2"
          >
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              {labels.previewTitle}
            </span>
            <Badge size="sm" variant={previewTone.badgeVariant}>
              {previewLabel}
            </Badge>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
            <div className="min-w-0">
              <div className="text-[var(--text-tertiary)]">
                {labels.modelStrengthLabel}
              </div>
              <div
                className="truncate font-medium text-[var(--text-primary)]"
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
                className="truncate font-medium text-[var(--text-primary)]"
                data-agent-tutti-budget-agent-count="true"
              >
                {agentCount}
              </div>
            </div>
          </div>
          <p className="mt-2 mb-0 text-[10px] leading-[1.35] text-[var(--text-tertiary)]">
            {labels.previewHint}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            data-agent-tutti-budget-cancel="true"
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => setOpen(false)}
          >
            {labels.cancel}
          </Button>
          <Button
            data-agent-tutti-budget-confirm="true"
            size="sm"
            type="button"
            onClick={() => {
              onConfirm(draftIntensity);
              setOpen(false);
            }}
          >
            {labels.confirm}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
