import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { resolveDockLabelTooltipAnchorRect } from "./dockLabelTooltipAnchor.ts";

export interface WorkbenchHostDockLabelTooltipTarget {
  key: string;
  label: string;
}

export interface WorkbenchHostDockLabelTooltipState extends WorkbenchHostDockLabelTooltipTarget {
  anchorKey: string;
  anchorRect: {
    height: number;
    left: number;
    top: number;
    width: number;
  };
}

export interface WorkbenchHostDockHoverPanelState {
  anchorKey: string;
  anchorRect: {
    height: number;
    left: number;
    top: number;
    width: number;
  };
  entryId: string;
}

const dockHoverPanelOpenDelayMs = 120;
const dockHoverPanelCloseDelayMs = 160;
const dockHoverPanelHitSlopPx = 12;
const dockHoverPanelBridgeSlopPx = 6;
const dockHoverPanelPointerRestTolerancePx = 4;

export function dockLabelTooltipTarget(
  key: string,
  label: string
): WorkbenchHostDockLabelTooltipTarget {
  return { key, label: label.trim() };
}

export function useWorkbenchHostDockOverlays({
  dockMeasureRef,
  flushPendingDockStateRefresh,
  handleDockPointerLeave,
  handleDockPointerMove,
  pauseDockMagnification,
  slotRefs,
  triggerDockBounce
}: {
  dockMeasureRef: RefObject<HTMLDivElement | null>;
  flushPendingDockStateRefresh: () => void;
  handleDockPointerLeave: () => void;
  handleDockPointerMove: (clientX: number, clientY: number) => void;
  pauseDockMagnification: () => void;
  slotRefs: RefObject<Map<string, HTMLElement>>;
  triggerDockBounce: (anchorKey: string) => void;
}) {
  const hoverPanelRef = useRef<HTMLDivElement | null>(null);
  const hoverPanelCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const hoverPanelOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const labelTooltipOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const hoverPanelScheduledPointRef = useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const labelTooltipScheduledPointRef = useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const hoverPanelRestTargetRef = useRef<{
    anchorKey: string;
    entryId: string;
  } | null>(null);
  const activeHoverPanelRef = useRef<WorkbenchHostDockHoverPanelState | null>(
    null
  );
  const activeLabelTooltipRef =
    useRef<WorkbenchHostDockLabelTooltipState | null>(null);
  const [activeHoverPanel, setActiveHoverPanel] =
    useState<WorkbenchHostDockHoverPanelState | null>(null);
  const [activeLabelTooltip, setActiveLabelTooltip] =
    useState<WorkbenchHostDockLabelTooltipState | null>(null);

  const clearHoverPanelCloseTimer = useCallback(() => {
    if (hoverPanelCloseTimerRef.current === null) {
      return;
    }
    clearTimeout(hoverPanelCloseTimerRef.current);
    hoverPanelCloseTimerRef.current = null;
  }, []);

  const clearHoverPanelOpenTimer = useCallback(() => {
    if (hoverPanelOpenTimerRef.current === null) {
      return;
    }
    clearTimeout(hoverPanelOpenTimerRef.current);
    hoverPanelOpenTimerRef.current = null;
    hoverPanelScheduledPointRef.current = null;
  }, []);

  const clearLabelTooltipOpenTimer = useCallback(() => {
    if (labelTooltipOpenTimerRef.current === null) {
      return;
    }
    clearTimeout(labelTooltipOpenTimerRef.current);
    labelTooltipOpenTimerRef.current = null;
    labelTooltipScheduledPointRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearHoverPanelCloseTimer();
      clearHoverPanelOpenTimer();
      clearLabelTooltipOpenTimer();
    },
    [
      clearHoverPanelCloseTimer,
      clearHoverPanelOpenTimer,
      clearLabelTooltipOpenTimer
    ]
  );

  const setDockHoverPanelOpen = useCallback(
    (open: boolean) => {
      if (open) {
        dockMeasureRef.current?.setAttribute(
          "data-dock-hover-panel-open",
          "true"
        );
        return;
      }
      dockMeasureRef.current?.removeAttribute("data-dock-hover-panel-open");
    },
    [dockMeasureRef]
  );

  useEffect(() => {
    activeHoverPanelRef.current = activeHoverPanel;
  }, [activeHoverPanel]);

  useEffect(() => {
    activeLabelTooltipRef.current = activeLabelTooltip;
  }, [activeLabelTooltip]);

  const closeLabelTooltipImmediate = useCallback(
    (targetKey?: string) => {
      clearLabelTooltipOpenTimer();
      if (
        targetKey !== undefined &&
        activeLabelTooltipRef.current?.key !== targetKey
      ) {
        return;
      }
      if (activeLabelTooltipRef.current === null) {
        return;
      }
      activeLabelTooltipRef.current = null;
      setActiveLabelTooltip(null);
    },
    [clearLabelTooltipOpenTimer]
  );

  const closeHoverPanelImmediate = useCallback(
    (entryId?: string) => {
      clearHoverPanelOpenTimer();
      clearHoverPanelCloseTimer();
      if (
        entryId !== undefined &&
        activeHoverPanelRef.current?.entryId !== entryId
      ) {
        return;
      }
      if (activeHoverPanelRef.current === null) {
        return;
      }
      hoverPanelRestTargetRef.current = null;
      setDockHoverPanelOpen(false);
      activeHoverPanelRef.current = null;
      setActiveHoverPanel(null);
      flushPendingDockStateRefresh();
    },
    [
      clearHoverPanelCloseTimer,
      clearHoverPanelOpenTimer,
      flushPendingDockStateRefresh,
      setDockHoverPanelOpen
    ]
  );

  const dismissHoverPanelForPopup = useCallback(() => {
    setDockHoverPanelOpen(false);
    setActiveHoverPanel(null);
  }, [setDockHoverPanelOpen]);

  const scheduleHoverPanelClose = useCallback(
    (entryId?: string) => {
      clearHoverPanelOpenTimer();
      clearHoverPanelCloseTimer();
      hoverPanelCloseTimerRef.current = setTimeout(() => {
        hoverPanelCloseTimerRef.current = null;
        closeHoverPanelImmediate(entryId);
        handleDockPointerLeave();
      }, dockHoverPanelCloseDelayMs);
    },
    [
      clearHoverPanelCloseTimer,
      clearHoverPanelOpenTimer,
      closeHoverPanelImmediate,
      handleDockPointerLeave
    ]
  );

  const showHoverPanel = useCallback(
    (entryId: string, anchorKey: string, anchorElement: HTMLElement): void => {
      const dockElement = dockMeasureRef.current;
      if (!dockElement) {
        return;
      }

      pauseDockMagnification();
      const dockRect = dockElement.getBoundingClientRect();
      const anchorRect = anchorElement.getBoundingClientRect();
      clearHoverPanelCloseTimer();
      const nextHoverPanel = {
        anchorKey,
        anchorRect: {
          height: anchorRect.height,
          left: anchorRect.left - dockRect.left,
          top: anchorRect.top - dockRect.top,
          width: anchorRect.width
        },
        entryId
      };
      setDockHoverPanelOpen(true);
      activeHoverPanelRef.current = nextHoverPanel;
      setActiveHoverPanel(nextHoverPanel);
    },
    [
      clearHoverPanelCloseTimer,
      dockMeasureRef,
      pauseDockMagnification,
      setDockHoverPanelOpen
    ]
  );

  const scheduleHoverPanelAfterRest = useCallback(
    (entryId: string, anchorKey: string) => {
      hoverPanelRestTargetRef.current = { anchorKey, entryId };
      clearHoverPanelOpenTimer();
      hoverPanelScheduledPointRef.current = null;
      hoverPanelOpenTimerRef.current = setTimeout(() => {
        hoverPanelOpenTimerRef.current = null;
        hoverPanelScheduledPointRef.current = null;
        const pending = hoverPanelRestTargetRef.current;
        if (!pending || pending.entryId !== entryId) {
          return;
        }
        const slotElement = slotRefs.current.get(anchorKey);
        if (!slotElement) {
          return;
        }
        showHoverPanel(entryId, anchorKey, slotElement);
      }, dockHoverPanelOpenDelayMs);
    },
    [clearHoverPanelOpenTimer, showHoverPanel, slotRefs]
  );

  const showLabelTooltip = useCallback(
    (
      target: WorkbenchHostDockLabelTooltipTarget,
      anchorKey: string,
      anchorElement: HTMLElement
    ): void => {
      const dockElement = dockMeasureRef.current;
      if (!dockElement) {
        return;
      }

      const dockRect = dockElement.getBoundingClientRect();
      const anchorRect = resolveDockLabelTooltipAnchorRect(anchorElement);
      clearLabelTooltipOpenTimer();
      const nextTooltip = {
        anchorKey,
        anchorRect: {
          height: anchorRect.height,
          left: anchorRect.left - dockRect.left,
          top: anchorRect.top - dockRect.top,
          width: anchorRect.width
        },
        key: target.key,
        label: target.label
      };
      activeLabelTooltipRef.current = nextTooltip;
      setActiveLabelTooltip(nextTooltip);
    },
    [clearLabelTooltipOpenTimer, dockMeasureRef]
  );

  const scheduleLabelTooltipAfterRest = useCallback(
    (target: WorkbenchHostDockLabelTooltipTarget, anchorKey: string) => {
      clearLabelTooltipOpenTimer();
      labelTooltipScheduledPointRef.current = null;
      labelTooltipOpenTimerRef.current = setTimeout(() => {
        labelTooltipOpenTimerRef.current = null;
        labelTooltipScheduledPointRef.current = null;
        const slotElement = slotRefs.current.get(anchorKey);
        if (!slotElement) {
          return;
        }
        showLabelTooltip(target, anchorKey, slotElement);
      }, dockHoverPanelOpenDelayMs);
    },
    [clearLabelTooltipOpenTimer, showLabelTooltip, slotRefs]
  );

  const resolveHoverPanelTargetAtPoint = useCallback(
    (
      clientX: number,
      clientY: number
    ): {
      anchorKey: string;
      entryId: string;
      slotElement: HTMLElement;
    } | null => {
      for (const [anchorKey, slotElement] of slotRefs.current) {
        const entryId = slotElement.dataset.dockHoverPanelEntryId;
        if (!entryId) {
          continue;
        }

        const rect = slotElement.getBoundingClientRect();
        if (
          clientX >= rect.left - dockHoverPanelHitSlopPx &&
          clientX <= rect.right + dockHoverPanelHitSlopPx &&
          clientY >= rect.top - dockHoverPanelHitSlopPx &&
          clientY <= rect.bottom + dockHoverPanelHitSlopPx
        ) {
          return { anchorKey, entryId, slotElement };
        }
      }
      return null;
    },
    [slotRefs]
  );

  const resolveLabelTooltipTargetAtPoint = useCallback(
    (
      clientX: number,
      clientY: number
    ): {
      anchorKey: string;
      slotElement: HTMLElement;
      target: WorkbenchHostDockLabelTooltipTarget;
    } | null => {
      for (const [anchorKey, slotElement] of slotRefs.current) {
        if (slotElement.dataset.dockHoverPanelEntryId) {
          continue;
        }
        const key = slotElement.dataset.dockLabelTooltipKey;
        const label = slotElement.dataset.dockLabelTooltipLabel?.trim() ?? "";
        if (!key || !label) {
          continue;
        }

        const rect = slotElement.getBoundingClientRect();
        if (
          clientX >= rect.left - dockHoverPanelHitSlopPx &&
          clientX <= rect.right + dockHoverPanelHitSlopPx &&
          clientY >= rect.top - dockHoverPanelHitSlopPx &&
          clientY <= rect.bottom + dockHoverPanelHitSlopPx
        ) {
          return {
            anchorKey,
            slotElement,
            target: { key, label }
          };
        }
      }
      return null;
    },
    [slotRefs]
  );

  const isPointerInsideActiveHoverPanelRegion = useCallback(
    (clientX: number, clientY: number): boolean => {
      const currentHoverPanel = activeHoverPanelRef.current;
      if (!currentHoverPanel) {
        return false;
      }

      const anchorSlot = slotRefs.current.get(currentHoverPanel.anchorKey);
      const panel = hoverPanelRef.current;
      if (
        !anchorSlot ||
        !panel ||
        !anchorSlot.isConnected ||
        !panel.isConnected
      ) {
        return false;
      }

      const anchorRect = anchorSlot.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return (
        rectContainsPoint(
          anchorRect,
          clientX,
          clientY,
          dockHoverPanelHitSlopPx
        ) ||
        rectContainsPoint(
          panelRect,
          clientX,
          clientY,
          dockHoverPanelHitSlopPx
        ) ||
        rectContainsPoint(
          createHoverPanelBridgeRect(anchorRect, panelRect),
          clientX,
          clientY,
          dockHoverPanelBridgeSlopPx
        )
      );
    },
    [slotRefs]
  );

  const scheduleHoverPanelAtPointAfterRest = useCallback(
    (clientX: number, clientY: number) => {
      const scheduledPoint = hoverPanelScheduledPointRef.current;
      if (
        hoverPanelOpenTimerRef.current !== null &&
        scheduledPoint &&
        Math.abs(clientX - scheduledPoint.clientX) <=
          dockHoverPanelPointerRestTolerancePx &&
        Math.abs(clientY - scheduledPoint.clientY) <=
          dockHoverPanelPointerRestTolerancePx
      ) {
        return;
      }

      clearHoverPanelOpenTimer();
      hoverPanelScheduledPointRef.current = { clientX, clientY };
      hoverPanelOpenTimerRef.current = setTimeout(() => {
        hoverPanelOpenTimerRef.current = null;
        hoverPanelScheduledPointRef.current = null;
        if (activeHoverPanelRef.current !== null) {
          return;
        }
        const target = resolveHoverPanelTargetAtPoint(clientX, clientY);
        if (!target) {
          hoverPanelRestTargetRef.current = null;
          return;
        }
        hoverPanelRestTargetRef.current = {
          anchorKey: target.anchorKey,
          entryId: target.entryId
        };
        showHoverPanel(target.entryId, target.anchorKey, target.slotElement);
      }, dockHoverPanelOpenDelayMs);
    },
    [clearHoverPanelOpenTimer, resolveHoverPanelTargetAtPoint, showHoverPanel]
  );

  const scheduleLabelTooltipAtPointAfterRest = useCallback(
    (clientX: number, clientY: number) => {
      if (activeLabelTooltipRef.current !== null) {
        return;
      }

      const scheduledPoint = labelTooltipScheduledPointRef.current;
      if (
        labelTooltipOpenTimerRef.current !== null &&
        scheduledPoint &&
        Math.abs(clientX - scheduledPoint.clientX) <=
          dockHoverPanelPointerRestTolerancePx &&
        Math.abs(clientY - scheduledPoint.clientY) <=
          dockHoverPanelPointerRestTolerancePx
      ) {
        return;
      }

      clearLabelTooltipOpenTimer();
      labelTooltipScheduledPointRef.current = { clientX, clientY };
      labelTooltipOpenTimerRef.current = setTimeout(() => {
        labelTooltipOpenTimerRef.current = null;
        labelTooltipScheduledPointRef.current = null;
        if (activeHoverPanelRef.current !== null) {
          return;
        }
        const target = resolveLabelTooltipTargetAtPoint(clientX, clientY);
        if (!target) {
          return;
        }
        showLabelTooltip(target.target, target.anchorKey, target.slotElement);
      }, dockHoverPanelOpenDelayMs);
    },
    [
      clearLabelTooltipOpenTimer,
      resolveLabelTooltipTargetAtPoint,
      showLabelTooltip
    ]
  );

  const beginDockIconInteraction = useCallback(
    (anchorKey: string) => {
      hoverPanelRestTargetRef.current = null;
      clearHoverPanelOpenTimer();
      closeLabelTooltipImmediate();
      closeHoverPanelImmediate();
      triggerDockBounce(anchorKey);
    },
    [
      clearHoverPanelOpenTimer,
      closeHoverPanelImmediate,
      closeLabelTooltipImmediate,
      triggerDockBounce
    ]
  );

  const handleDockPointerTravel = useCallback(
    (clientX: number, clientY: number) => {
      if (activeHoverPanelRef.current !== null) {
        closeLabelTooltipImmediate();
        if (isPointerInsideActiveHoverPanelRegion(clientX, clientY)) {
          clearHoverPanelCloseTimer();
          return;
        }
        scheduleHoverPanelClose(activeHoverPanelRef.current.entryId);
        handleDockPointerLeave();
        return;
      }

      const currentLabelTooltip = activeLabelTooltipRef.current;
      if (currentLabelTooltip) {
        const target = resolveLabelTooltipTargetAtPoint(clientX, clientY);
        if (target?.target.key !== currentLabelTooltip.key) {
          closeLabelTooltipImmediate(currentLabelTooltip.key);
        }
      }

      handleDockPointerMove(clientX, clientY);
      scheduleHoverPanelAtPointAfterRest(clientX, clientY);
      scheduleLabelTooltipAtPointAfterRest(clientX, clientY);
    },
    [
      clearHoverPanelCloseTimer,
      closeLabelTooltipImmediate,
      handleDockPointerMove,
      handleDockPointerLeave,
      isPointerInsideActiveHoverPanelRegion,
      resolveLabelTooltipTargetAtPoint,
      scheduleHoverPanelClose,
      scheduleHoverPanelAtPointAfterRest,
      scheduleLabelTooltipAtPointAfterRest
    ]
  );

  const clearHoverPanelRestTarget = useCallback(() => {
    hoverPanelRestTargetRef.current = null;
  }, []);

  const clearHoverPanelRestTargetForAnchor = useCallback(
    (anchorKey: string) => {
      if (hoverPanelRestTargetRef.current?.anchorKey === anchorKey) {
        hoverPanelRestTargetRef.current = null;
      }
    },
    []
  );

  const handleDockRootPointerLeave = useCallback(() => {
    hoverPanelRestTargetRef.current = null;
    clearHoverPanelOpenTimer();
    clearLabelTooltipOpenTimer();
    closeLabelTooltipImmediate();
    closeHoverPanelImmediate();
    handleDockPointerLeave();
    flushPendingDockStateRefresh();
  }, [
    clearHoverPanelOpenTimer,
    clearLabelTooltipOpenTimer,
    closeHoverPanelImmediate,
    closeLabelTooltipImmediate,
    flushPendingDockStateRefresh,
    handleDockPointerLeave
  ]);

  return {
    activeHoverPanel,
    activeLabelTooltip,
    beginDockIconInteraction,
    clearHoverPanelCloseTimer,
    clearHoverPanelOpenTimer,
    clearHoverPanelRestTarget,
    clearHoverPanelRestTargetForAnchor,
    clearLabelTooltipOpenTimer,
    closeHoverPanelImmediate,
    closeLabelTooltipImmediate,
    dismissHoverPanelForPopup,
    handleDockPointerTravel,
    handleDockRootPointerLeave,
    hoverPanelRef,
    scheduleHoverPanelAfterRest,
    scheduleHoverPanelAtPointAfterRest,
    scheduleHoverPanelClose,
    scheduleLabelTooltipAfterRest,
    scheduleLabelTooltipAtPointAfterRest,
    showHoverPanel,
    showLabelTooltip
  };
}

function rectContainsPoint(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  slopPx = 0
): boolean {
  return (
    clientX >= rect.left - slopPx &&
    clientX <= rect.right + slopPx &&
    clientY >= rect.top - slopPx &&
    clientY <= rect.bottom + slopPx
  );
}

function createHoverPanelBridgeRect(anchor: DOMRect, panel: DOMRect): DOMRect {
  if (anchor.right <= panel.left || panel.right <= anchor.left) {
    const left = Math.min(anchor.right, panel.right);
    const right = Math.max(anchor.left, panel.left);
    const top = Math.max(anchor.top, panel.top);
    const bottom = Math.min(anchor.bottom, panel.bottom);
    return new DOMRect(left, top, right - left, Math.max(0, bottom - top));
  }

  const left = Math.max(anchor.left, panel.left);
  const right = Math.min(anchor.right, panel.right);
  const top = Math.min(anchor.bottom, panel.bottom);
  const bottom = Math.max(anchor.top, panel.top);
  return new DOMRect(left, top, Math.max(0, right - left), bottom - top);
}
