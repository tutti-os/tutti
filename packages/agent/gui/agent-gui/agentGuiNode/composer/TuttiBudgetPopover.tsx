import { useState, type ReactNode } from "react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider
} from "@tutti-os/ui-system";

export interface TuttiBudgetPopoverLabels {
  title: string;
  intensityLabel: string;
  intensityMin: string;
  intensityMax: string;
  confirm: string;
  cancel: string;
}

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
        <div className="grid gap-1.5 text-[12px] text-[var(--text-secondary)]">
          <div className="flex items-center justify-between gap-2">
            <span>{labels.intensityLabel}</span>
            <span
              className="text-[var(--text-primary)] tabular-nums"
              data-agent-tutti-budget-intensity-value="true"
            >
              {draftIntensity}
            </span>
          </div>
          <Slider
            aria-label={labels.intensityLabel}
            max={100}
            min={0}
            step={1}
            value={[draftIntensity]}
            onValueChange={(values) =>
              setDraftIntensity(values[0] ?? draftIntensity)
            }
          />
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span>{labels.intensityMin}</span>
            <span>{labels.intensityMax}</span>
          </div>
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
