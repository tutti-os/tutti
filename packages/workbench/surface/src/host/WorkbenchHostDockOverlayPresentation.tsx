import {
  useRef,
  type CSSProperties,
  type Dispatch,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction
} from "react";
import { Button } from "@tutti-os/ui-system";
import { dockActionKey } from "./dockActions.ts";
import type {
  WorkbenchHostDockHoverPanelState,
  WorkbenchHostDockLabelTooltipState
} from "./useWorkbenchHostDockOverlays.ts";
import type {
  WorkbenchHostDockEntry,
  WorkbenchHostHandle,
  WorkbenchHostProps
} from "./types.ts";

export function WorkbenchHostDockLabelTooltip({
  placement,
  state
}: {
  placement: WorkbenchHostProps["dockPlacement"];
  state: WorkbenchHostDockLabelTooltipState;
}) {
  return (
    <div
      className="desktop-dock__label-tooltip"
      data-dock-placement={placement}
      role="tooltip"
      style={
        {
          "--desktop-dock-label-tooltip-anchor-height": `${state.anchorRect.height}px`,
          "--desktop-dock-label-tooltip-anchor-left": `${state.anchorRect.left}px`,
          "--desktop-dock-label-tooltip-anchor-top": `${state.anchorRect.top}px`,
          "--desktop-dock-label-tooltip-anchor-width": `${state.anchorRect.width}px`
        } as WorkbenchHostDockLabelTooltipStyle
      }
    >
      {state.label}
    </div>
  );
}

export function WorkbenchHostDockHoverPanel({
  entry,
  host,
  hoverPanelRef,
  onBlur,
  onDockEntryAction,
  onFocus,
  onPointerEnter,
  onPointerLeave,
  pendingActionKeys,
  placement,
  setPendingActionKeys,
  state
}: {
  entry: WorkbenchHostDockEntry | null;
  host: WorkbenchHostHandle;
  hoverPanelRef: RefObject<HTMLDivElement | null>;
  onDockEntryAction?: (input: {
    actionId: string;
    entryId: string;
    host: WorkbenchHostHandle;
  }) => Promise<void> | void;
  onBlur?: (event: ReactFocusEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  pendingActionKeys: Set<string>;
  placement: WorkbenchHostProps["dockPlacement"];
  setPendingActionKeys: Dispatch<SetStateAction<Set<string>>>;
  state: WorkbenchHostDockHoverPanelState;
}) {
  const lastPointerActionAtRef = useRef<Map<string, number>>(new Map());
  if (!entry) {
    return null;
  }
  const hoverPanelEntry = entry;

  const runHoverAction = (
    actionKey: string,
    actionId: string,
    disabled: boolean
  ): void => {
    if (disabled || pendingActionKeys.has(actionKey)) {
      return;
    }
    setPendingActionKeys((current) => {
      const next = new Set(current);
      next.add(actionKey);
      return next;
    });
    void (async () => {
      try {
        await onDockEntryAction?.({
          actionId,
          entryId: hoverPanelEntry.id,
          host
        });
      } catch {
        // Keep dock action failures contained.
      } finally {
        setPendingActionKeys((current) => {
          if (!current.has(actionKey)) {
            return current;
          }
          const next = new Set(current);
          next.delete(actionKey);
          return next;
        });
      }
    })();
  };

  return (
    <div
      ref={hoverPanelRef}
      className="desktop-dock__hover-panel"
      data-dock-placement={placement}
      role="group"
      aria-label={entry.label}
      onBlur={onBlur}
      onFocus={onFocus}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={
        {
          "--desktop-dock-hover-panel-anchor-height": `${state.anchorRect.height}px`,
          "--desktop-dock-hover-panel-anchor-left": `${state.anchorRect.left}px`,
          "--desktop-dock-hover-panel-anchor-top": `${state.anchorRect.top}px`,
          "--desktop-dock-hover-panel-anchor-width": `${state.anchorRect.width}px`
        } as WorkbenchHostDockHoverPanelStyle
      }
    >
      <div className="desktop-dock__hover-panel-title">{entry.label}</div>
      {entry.state?.reason ? (
        <div className="desktop-dock__hover-panel-description">
          {stripDockDescriptionTerminalPunctuation(entry.state.reason)}
        </div>
      ) : null}
      {entry.hoverActions?.length ? (
        <div className="desktop-dock__hover-actions">
          {entry.hoverActions.map((action) => {
            const actionKey = dockActionKey(entry.id, action.id);
            const isLocallyPending = pendingActionKeys.has(actionKey);
            const isPending =
              isLocallyPending ||
              (action.disabled === true && action.pendingLabel !== undefined);
            return (
              <Button
                key={action.id}
                aria-busy={isPending ? true : undefined}
                className="desktop-dock__hover-action"
                disabled={action.disabled || isLocallyPending}
                type="button"
                onPointerDown={(event) => {
                  // Pointer activation runs before a re-render can tear down the
                  // hover panel. The trailing synthetic click is deduplicated.
                  if (event.button !== 0) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  lastPointerActionAtRef.current.set(
                    actionKey,
                    performance.now()
                  );
                  runHoverAction(
                    actionKey,
                    action.id,
                    action.disabled === true
                  );
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const lastPointerAt =
                    lastPointerActionAtRef.current.get(actionKey);
                  if (
                    lastPointerAt !== undefined &&
                    performance.now() - lastPointerAt < 700
                  ) {
                    return;
                  }
                  runHoverAction(
                    actionKey,
                    action.id,
                    action.disabled === true
                  );
                }}
              >
                {isPending
                  ? (action.pendingLabel ?? action.label)
                  : action.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function stripDockDescriptionTerminalPunctuation(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.endsWith("...") || trimmed.endsWith("…")) {
    return trimmed;
  }
  return trimmed.replace(/[。．.]+$/u, "");
}

interface WorkbenchHostDockHoverPanelStyle extends CSSProperties {
  "--desktop-dock-hover-panel-anchor-height"?: string;
  "--desktop-dock-hover-panel-anchor-left"?: string;
  "--desktop-dock-hover-panel-anchor-top"?: string;
  "--desktop-dock-hover-panel-anchor-width"?: string;
}

interface WorkbenchHostDockLabelTooltipStyle extends CSSProperties {
  "--desktop-dock-label-tooltip-anchor-height"?: string;
  "--desktop-dock-label-tooltip-anchor-left"?: string;
  "--desktop-dock-label-tooltip-anchor-top"?: string;
  "--desktop-dock-label-tooltip-anchor-width"?: string;
}
