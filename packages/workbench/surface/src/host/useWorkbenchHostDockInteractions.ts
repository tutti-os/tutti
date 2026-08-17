import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { minimizedDockSlotLayoutAnimationMs } from "./dockItems.ts";
import type { WorkbenchMinimizedDockRestoreIntent } from "./minimizedDockRestoreIntent.ts";
import { dockEntryClickThrottleMs } from "./useWorkbenchHostDockBounce.ts";

type WorkbenchMinimizedDockNodeSlotRestoreIntent = Extract<
  WorkbenchMinimizedDockRestoreIntent,
  { kind: "node-slot" }
>;

type WorkbenchMinimizedDockStackPopupCardRestoreIntent = Extract<
  WorkbenchMinimizedDockRestoreIntent,
  { kind: "stack-popup-card" }
>;

export function useWorkbenchHostDockInteractions({
  clearHoverPanelOpenTimer,
  clearHoverPanelRestTarget,
  clearLabelTooltipOpenTimer,
  clearSlotMagnification,
  closeHoverPanelImmediate,
  closeLabelTooltipImmediate,
  pauseDockMagnification,
  slotRefs
}: {
  clearHoverPanelOpenTimer: () => void;
  clearHoverPanelRestTarget: () => void;
  clearLabelTooltipOpenTimer: () => void;
  clearSlotMagnification: (anchorKey: string) => void;
  closeHoverPanelImmediate: (entryId?: string) => void;
  closeLabelTooltipImmediate: (targetKey?: string) => void;
  pauseDockMagnification: () => void;
  slotRefs: RefObject<Map<string, HTMLElement>>;
}) {
  const dockEntryClickThrottleUntilRef = useRef(new Map<string, number>());
  const [
    collapsingMinimizedLaunchAnchorKeys,
    setCollapsingMinimizedLaunchAnchorKeys
  ] = useState<Set<string>>(() => new Set());
  const collapsingMinimizedLaunchTimerRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );

  useEffect(
    () => () => {
      for (const timer of collapsingMinimizedLaunchTimerRef.current.values()) {
        clearTimeout(timer);
      }
      collapsingMinimizedLaunchTimerRef.current.clear();
    },
    []
  );

  const clearCollapsingMinimizedLaunch = useCallback(
    (anchorKey: string) => {
      const timer = collapsingMinimizedLaunchTimerRef.current.get(anchorKey);
      if (timer) {
        clearTimeout(timer);
        collapsingMinimizedLaunchTimerRef.current.delete(anchorKey);
      }
      const slotElement = slotRefs.current.get(anchorKey);
      slotElement?.removeAttribute("data-collapsing");
      slotElement?.style.removeProperty("--desktop-dock-collapse-inline-size");
      slotElement?.style.removeProperty("--desktop-dock-collapse-block-size");
      setCollapsingMinimizedLaunchAnchorKeys((current) => {
        if (!current.has(anchorKey)) {
          return current;
        }
        const next = new Set(current);
        next.delete(anchorKey);
        return next;
      });
    },
    [slotRefs]
  );

  const scheduleCollapsingMinimizedLaunchClear = useCallback(
    (anchorKey: string) => {
      const existing = collapsingMinimizedLaunchTimerRef.current.get(anchorKey);
      if (existing) {
        clearTimeout(existing);
      }
      collapsingMinimizedLaunchTimerRef.current.set(
        anchorKey,
        setTimeout(() => {
          clearCollapsingMinimizedLaunch(anchorKey);
        }, minimizedDockSlotLayoutAnimationMs)
      );
    },
    [clearCollapsingMinimizedLaunch]
  );

  const isDockEntryClickThrottled = useCallback(
    (anchorKey: string): boolean => {
      const throttledUntil =
        dockEntryClickThrottleUntilRef.current.get(anchorKey);
      return throttledUntil !== undefined && Date.now() < throttledUntil;
    },
    []
  );

  const claimDockEntryClick = useCallback((anchorKey: string): void => {
    dockEntryClickThrottleUntilRef.current.set(
      anchorKey,
      Date.now() + dockEntryClickThrottleMs
    );
  }, []);

  const beginDockMinimizedInteraction = useCallback(
    (anchorKey?: string): boolean => {
      clearHoverPanelRestTarget();
      clearHoverPanelOpenTimer();
      clearLabelTooltipOpenTimer();
      closeLabelTooltipImmediate();
      closeHoverPanelImmediate();
      pauseDockMagnification();

      if (!anchorKey) {
        return false;
      }
      const slotElement = slotRefs.current.get(anchorKey);
      if (!slotElement) {
        return false;
      }
      clearSlotMagnification(anchorKey);
      if (slotElement.dataset.collapsing === "true") {
        return true;
      }
      const rect = slotElement.getBoundingClientRect();
      slotElement.style.setProperty(
        "--desktop-dock-collapse-inline-size",
        `${rect.width}px`
      );
      slotElement.style.setProperty(
        "--desktop-dock-collapse-block-size",
        `${rect.height}px`
      );
      slotElement.dataset.collapsing = "true";
      return true;
    },
    [
      clearHoverPanelOpenTimer,
      clearHoverPanelRestTarget,
      clearLabelTooltipOpenTimer,
      clearSlotMagnification,
      closeHoverPanelImmediate,
      closeLabelTooltipImmediate,
      pauseDockMagnification,
      slotRefs
    ]
  );

  const runDockMinimizedLaunchAfterCollapse = useCallback(
    (
      intent: WorkbenchMinimizedDockNodeSlotRestoreIntent,
      launch: (intent: WorkbenchMinimizedDockNodeSlotRestoreIntent) => void
    ) => {
      const { anchorKey } = intent;
      beginDockMinimizedInteraction(anchorKey);
      setCollapsingMinimizedLaunchAnchorKeys((current) => {
        const next = new Set(current);
        next.add(anchorKey);
        return next;
      });
      scheduleCollapsingMinimizedLaunchClear(anchorKey);
      launch(intent);
    },
    [beginDockMinimizedInteraction, scheduleCollapsingMinimizedLaunchClear]
  );

  const runDockMinimizedStackLaunch = useCallback(
    (
      intent: WorkbenchMinimizedDockStackPopupCardRestoreIntent,
      launch: (
        intent: WorkbenchMinimizedDockStackPopupCardRestoreIntent
      ) => void
    ) => {
      beginDockMinimizedInteraction();
      launch(intent);
    },
    [beginDockMinimizedInteraction]
  );

  return {
    beginDockMinimizedInteraction,
    claimDockEntryClick,
    clearCollapsingMinimizedLaunch,
    collapsingMinimizedLaunchAnchorKeys,
    isDockEntryClickThrottled,
    runDockMinimizedLaunchAfterCollapse,
    runDockMinimizedStackLaunch
  };
}
