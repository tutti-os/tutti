import type {
  FocusEvent as ReactFocusEvent,
  PointerEvent as ReactPointerEvent,
  RefObject
} from "react";
import {
  resolveWorkbenchDockEntryClick,
  type ResolvedWorkbenchHostDockEntry
} from "./dockEntries.ts";
import { resolveDockEntryInstanceMode } from "./dockItems.ts";
import type { WorkbenchHostDockPresence } from "./dockPresence.ts";
import { dockLabelTooltipTarget } from "./useWorkbenchHostDockOverlays.ts";
import type {
  WorkbenchHostDockEntryActivationInput,
  WorkbenchHostDockEntryContextMenuInput
} from "./useWorkbenchHostDockEntryActivation.ts";
import type { WorkbenchHostDockPopupState } from "./WorkbenchHostDockPopup.tsx";
import type {
  WorkbenchHostDockEntry,
  WorkbenchHostNodeDefinition
} from "./types.ts";
import type { WorkbenchDockWallpaperTone } from "./useWorkbenchHostDockWallpaperTones.ts";

interface WorkbenchHostDockEntryOverlayController {
  clearHoverPanelOpenTimer: () => void;
  clearHoverPanelRestTargetForAnchor: (anchorKey: string) => void;
  clearLabelTooltipOpenTimer: () => void;
  closeHoverPanelImmediate: (entryId?: string) => void;
  closeLabelTooltipImmediate: (targetKey?: string) => void;
  dockMeasureRef: RefObject<HTMLDivElement | null>;
  handleDockPointerLeave: () => void;
  hoverPanelRef: RefObject<HTMLDivElement | null>;
  scheduleHoverPanelAfterRest: (entryId: string, anchorKey: string) => void;
  scheduleHoverPanelAtPointAfterRest: (
    clientX: number,
    clientY: number
  ) => void;
  scheduleLabelTooltipAfterRest: (
    target: { key: string; label: string },
    anchorKey: string
  ) => void;
  scheduleLabelTooltipAtPointAfterRest: (
    clientX: number,
    clientY: number
  ) => void;
  showHoverPanel: (
    entryId: string,
    anchorKey: string,
    anchorElement: HTMLElement
  ) => void;
  showLabelTooltip: (
    target: { key: string; label: string },
    anchorKey: string,
    anchorElement: HTMLElement
  ) => void;
}

export function WorkbenchHostDockEntrySlot({
  activeAttention,
  beginDockIconInteraction,
  claimDockEntryClick,
  currentPopup,
  isDockEntryClickThrottled,
  launchLabel,
  nodeDefinitions,
  onActivate,
  onOpenContextMenu,
  overlay,
  presence,
  registerDockSlot,
  resolvedEntry,
  wallpaperTone
}: {
  activeAttention: boolean;
  beginDockIconInteraction: (anchorKey: string) => void;
  claimDockEntryClick: (anchorKey: string) => void;
  currentPopup: WorkbenchHostDockPopupState | null;
  isDockEntryClickThrottled: (anchorKey: string) => boolean;
  launchLabel: string;
  nodeDefinitions: ReadonlyMap<string, WorkbenchHostNodeDefinition>;
  onActivate: (input: WorkbenchHostDockEntryActivationInput) => void;
  onOpenContextMenu: (input: WorkbenchHostDockEntryContextMenuInput) => void;
  overlay: WorkbenchHostDockEntryOverlayController;
  presence: WorkbenchHostDockPresence;
  registerDockSlot: (
    anchorKey: string
  ) => (element: HTMLElement | null) => void;
  resolvedEntry: ResolvedWorkbenchHostDockEntry;
  wallpaperTone?: WorkbenchDockWallpaperTone;
}) {
  const { anchorKey, entry } = resolvedEntry;
  const instanceMode = resolveDockEntryInstanceMode(entry, nodeDefinitions);
  const clickResolution = resolveWorkbenchDockEntryClick({
    entry,
    instanceMode,
    matchedNodes: resolvedEntry.matchedNodes
  });
  const hasHoverPanel = dockEntryHasHoverPanel(entry);
  const labelTooltip = hasHoverPanel
    ? null
    : dockLabelTooltipTarget(`entry:${entry.id}`, entry.label);

  return (
    <span
      ref={registerDockSlot(anchorKey)}
      className="desktop-dock__slot"
      data-attention-active={activeAttention ? "true" : undefined}
      data-desktop-dock-anchor-key={anchorKey}
      data-desktop-dock-slot="true"
      data-entry-state={entry.state?.kind ?? "enabled"}
      data-dock-hover-panel-entry-id={hasHoverPanel ? entry.id : undefined}
      data-dock-label-tooltip-key={labelTooltip?.key}
      data-dock-label-tooltip-label={labelTooltip?.label}
      data-icon-size={entry.iconSize ?? "default"}
      data-node-state={resolvedEntry.dockNodeState}
      data-popup-active={currentPopup ? "true" : undefined}
      data-presence={presence}
      data-section-id={entry.sectionId}
      data-wallpaper-tone={wallpaperTone}
      onBlur={(event) =>
        handleEntryBlur(event, entry.id, hasHoverPanel, labelTooltip, overlay)
      }
      onFocus={(event) => {
        if (hasHoverPanel) {
          overlay.showHoverPanel(entry.id, anchorKey, event.currentTarget);
          return;
        }
        if (labelTooltip) {
          overlay.showLabelTooltip(
            labelTooltip,
            anchorKey,
            event.currentTarget
          );
        }
      }}
      onPointerEnter={() => {
        if (hasHoverPanel) {
          overlay.scheduleHoverPanelAfterRest(entry.id, anchorKey);
          return;
        }
        if (labelTooltip) {
          overlay.scheduleLabelTooltipAfterRest(labelTooltip, anchorKey);
        }
      }}
      onPointerLeave={(event) =>
        handleEntryPointerLeave(
          event,
          anchorKey,
          entry.id,
          hasHoverPanel,
          labelTooltip,
          overlay
        )
      }
    >
      <button
        aria-expanded={currentPopup ? true : undefined}
        aria-haspopup={
          clickResolution.kind === "open-popup" ? "dialog" : undefined
        }
        aria-label={launchLabel}
        aria-disabled={clickResolution.kind === "blocked" ? true : undefined}
        className="desktop-dock__btn"
        data-interactive={clickResolution.kind === "blocked" ? "false" : "true"}
        data-dock-hover-panel-trigger={hasHoverPanel ? "true" : undefined}
        type="button"
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            clickResolution.kind === "blocked" ||
            isDockEntryClickThrottled(anchorKey)
          ) {
            return;
          }
          beginDockIconInteraction(anchorKey);
        }}
        onClick={(event) => {
          if (
            clickResolution.kind === "blocked" ||
            isDockEntryClickThrottled(anchorKey)
          ) {
            return;
          }
          claimDockEntryClick(anchorKey);
          onActivate({
            anchorKey,
            clickResolution,
            currentPopup,
            instanceMode,
            resolvedEntry,
            triggerRect:
              clickResolution.kind === "open-popup"
                ? event.currentTarget.getBoundingClientRect()
                : null
          });
        }}
        onContextMenu={(event) => {
          if (
            clickResolution.kind === "blocked" ||
            !dockEntryHasContextMenu(entry, resolvedEntry)
          ) {
            return;
          }
          event.preventDefault();
          onOpenContextMenu({
            anchorKey,
            resolvedEntry,
            triggerRect: event.currentTarget.getBoundingClientRect()
          });
        }}
      >
        <span
          className="desktop-dock__icon-shell"
          data-desktop-dock-icon-shell="true"
          data-entry-state={entry.state?.kind ?? "enabled"}
          aria-hidden
        >
          <span className="desktop-dock__icon-content">{entry.icon}</span>
          {renderDockBadge(entry, resolvedEntry.matchedNodes.length)}
        </span>
      </button>
    </span>
  );
}

export function dockEntryHasHoverPanel(entry: WorkbenchHostDockEntry): boolean {
  return (
    Boolean(entry.state?.reason?.trim()) ||
    (entry.hoverActions?.length ?? 0) > 0
  );
}

function dockEntryHasContextMenu(
  entry: WorkbenchHostDockEntry,
  resolvedEntry: ResolvedWorkbenchHostDockEntry
): boolean {
  if (resolvedEntry.matchedNodes.length > 0 || entry.dockRetention) {
    return true;
  }
  return entry.clickActionId === undefined;
}

function renderDockBadge(
  entry: WorkbenchHostDockEntry,
  matchedNodeCount: number
) {
  const badge =
    entry.badge ??
    (matchedNodeCount > 1
      ? ({ kind: "count", value: matchedNodeCount } as const)
      : null);
  if (!badge) {
    return null;
  }
  if (badge.kind === "count") {
    return <span className="desktop-dock__count-badge">{badge.value}</span>;
  }
  if (badge.kind === "custom") {
    return <span className="desktop-dock__custom-badge">{badge.content}</span>;
  }
  return (
    <span className="desktop-dock__status-badge" data-status={badge.status} />
  );
}

function handleEntryBlur(
  event: ReactFocusEvent<HTMLSpanElement>,
  entryId: string,
  hasHoverPanel: boolean,
  labelTooltip: { key: string; label: string } | null,
  overlay: WorkbenchHostDockEntryOverlayController
) {
  if (hasHoverPanel && !event.currentTarget.contains(event.relatedTarget)) {
    overlay.closeHoverPanelImmediate(entryId);
  }
  if (labelTooltip && !event.currentTarget.contains(event.relatedTarget)) {
    overlay.closeLabelTooltipImmediate(labelTooltip.key);
  }
}

function handleEntryPointerLeave(
  event: ReactPointerEvent<HTMLSpanElement>,
  anchorKey: string,
  entryId: string,
  hasHoverPanel: boolean,
  labelTooltip: { key: string; label: string } | null,
  overlay: WorkbenchHostDockEntryOverlayController
) {
  if (!hasHoverPanel) {
    if (labelTooltip) {
      overlay.clearLabelTooltipOpenTimer();
      overlay.closeLabelTooltipImmediate(labelTooltip.key);
      const relatedTarget = event.relatedTarget;
      if (
        relatedTarget instanceof Node &&
        overlay.dockMeasureRef.current?.contains(relatedTarget)
      ) {
        overlay.scheduleLabelTooltipAtPointAfterRest(
          event.clientX,
          event.clientY
        );
      }
    }
    return;
  }
  const relatedTarget = event.relatedTarget;
  if (
    relatedTarget instanceof Node &&
    overlay.hoverPanelRef.current?.contains(relatedTarget)
  ) {
    return;
  }
  if (
    relatedTarget instanceof Node &&
    overlay.dockMeasureRef.current?.contains(relatedTarget)
  ) {
    overlay.scheduleHoverPanelAtPointAfterRest(event.clientX, event.clientY);
    return;
  }
  overlay.clearHoverPanelRestTargetForAnchor(anchorKey);
  overlay.clearHoverPanelOpenTimer();
  overlay.closeHoverPanelImmediate(entryId);
  overlay.handleDockPointerLeave();
}
