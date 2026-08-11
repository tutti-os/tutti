import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  DOCK_ICON_PEAK_SIZE,
  useDockMagnification
} from "./dockMagnification.ts";
import {
  resolveWorkbenchHostDockScrollState,
  type WorkbenchHostDockScrollState
} from "./dockScrollState.ts";
import type { WorkbenchHostProps } from "./types.ts";
import { useWorkbenchHostDockBounce } from "./useWorkbenchHostDockBounce.ts";
import { useWorkbenchHostDockWallpaperTones } from "./useWorkbenchHostDockWallpaperTones.ts";

export type WorkbenchHostDockScrollDirection = "backward" | "forward";

const desktopDockPlateChromeWidth = 15.3;

export function useWorkbenchHostDockViewport({
  dockItemsCount,
  dockItemsKey,
  dockPlacement,
  dockWidth,
  registerDockAnchor
}: {
  dockItemsCount: number;
  dockItemsKey: string;
  dockPlacement: NonNullable<WorkbenchHostProps["dockPlacement"]>;
  dockWidth: number;
  registerDockAnchor: (anchorKey: string, element: HTMLElement | null) => void;
}) {
  const dockPlateRef = useRef<HTMLDivElement | null>(null);
  const dockMeasureRef = useRef<HTMLDivElement | null>(null);
  const dockItemsRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef(new Map<string, HTMLElement>());
  const wallpaperToneElementRefs = useRef(new Map<string, HTMLElement>());
  const dockSlotRefCallbacksRef = useRef(
    new Map<string, (element: HTMLElement | null) => void>()
  );
  const clearSlotMagnificationRef = useRef<(anchorKey: string) => void>(() => {
    return;
  });
  const registerDockAnchorRef = useRef(registerDockAnchor);
  const [dockFrameSize, setDockFrameSize] = useState<number | null>(null);
  const [dockScrollState, setDockScrollState] =
    useState<WorkbenchHostDockScrollState>(() => ({
      canScrollBackward: false,
      canScrollForward: false,
      hasOverflow: false
    }));
  const { triggerDockBounce } = useWorkbenchHostDockBounce(slotRefs);

  useLayoutEffect(() => {
    const element = dockMeasureRef.current;
    if (!element || typeof window === "undefined") {
      return undefined;
    }

    let frameId: number | null = null;
    const updateDockFrameSize = () => {
      frameId = null;
      if (isDockVisualMutationActive(dockMeasureRef.current)) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const nextSize = Math.ceil(
        (dockPlacement === "left" ? rect.height : rect.width) +
          desktopDockPlateChromeWidth
      );
      setDockFrameSize((current) =>
        current === nextSize ? current : nextSize
      );
    };
    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(updateDockFrameSize);
    };

    updateDockFrameSize();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [dockPlacement]);

  const wallpaperTones = useWorkbenchHostDockWallpaperTones({
    dockItemsRef,
    elementRefs: wallpaperToneElementRefs,
    itemKeys: dockItemsKey
  });
  const magnification = useDockMagnification({
    dockPlateRef,
    dockPlacement,
    dockRootRef: dockMeasureRef,
    dockViewportRef: dockItemsRef,
    slotRefs
  });

  clearSlotMagnificationRef.current = magnification.clearSlotMagnification;
  registerDockAnchorRef.current = registerDockAnchor;

  const updateDockScrollState = useCallback(() => {
    const scrollElement = dockItemsRef.current;
    const viewportElement = dockMeasureRef.current;
    if (!scrollElement || !viewportElement) {
      setDockScrollState((current) =>
        current.hasOverflow ||
        current.canScrollBackward ||
        current.canScrollForward
          ? {
              canScrollBackward: false,
              canScrollForward: false,
              hasOverflow: false
            }
          : current
      );
      return;
    }

    const isVertical = dockPlacement === "left";
    const viewportSize = isVertical
      ? viewportElement.clientHeight
      : viewportElement.clientWidth;
    const scrollSize = isVertical
      ? scrollElement.scrollHeight
      : scrollElement.scrollWidth;
    const scrollOffset = isVertical
      ? scrollElement.scrollTop
      : scrollElement.scrollLeft;
    const nextState = resolveWorkbenchHostDockScrollState({
      contentSize: dockWidth,
      scrollOffset,
      scrollSize,
      viewportSize
    });

    setDockScrollState((current) =>
      current.canScrollBackward === nextState.canScrollBackward &&
      current.canScrollForward === nextState.canScrollForward &&
      current.hasOverflow === nextState.hasOverflow
        ? current
        : nextState
    );
  }, [dockPlacement, dockWidth]);

  useLayoutEffect(() => {
    const element = dockItemsRef.current;
    if (!element || typeof window === "undefined") {
      return undefined;
    }

    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (isDockVisualMutationActive(dockMeasureRef.current)) {
        return;
      }
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateDockScrollState();
      });
    };

    updateDockScrollState();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduleUpdate);
    element.addEventListener("scroll", scheduleUpdate, { passive: true });

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      element.removeEventListener("scroll", scheduleUpdate);
    };
  }, [dockItemsCount, dockPlacement, updateDockScrollState]);

  const registerWallpaperToneElement = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      if (element) {
        wallpaperToneElementRefs.current.set(key, element);
        return;
      }
      wallpaperToneElementRefs.current.delete(key);
    },
    []
  );

  const registerDockSlot = useCallback((anchorKey: string) => {
    const existing = dockSlotRefCallbacksRef.current.get(anchorKey);
    if (existing) {
      return existing;
    }

    const callback = (element: HTMLElement | null) => {
      if (element) {
        slotRefs.current.set(anchorKey, element);
        wallpaperToneElementRefs.current.set(anchorKey, element);
      } else {
        slotRefs.current.delete(anchorKey);
        wallpaperToneElementRefs.current.delete(anchorKey);
        if (!dockMeasureRef.current?.hasAttribute("data-dock-pointer-active")) {
          clearSlotMagnificationRef.current(anchorKey);
        }
      }
      registerDockAnchorRef.current(anchorKey, element);
    };
    dockSlotRefCallbacksRef.current.set(anchorKey, callback);
    return callback;
  }, []);

  const scrollDockItems = useCallback(
    (direction: WorkbenchHostDockScrollDirection) => {
      const element = dockItemsRef.current;
      if (!element) {
        return;
      }

      const isVertical = dockPlacement === "left";
      const viewportSize = isVertical
        ? element.clientHeight
        : element.clientWidth;
      const delta =
        Math.max(DOCK_ICON_PEAK_SIZE * 2, viewportSize * 0.72) *
        (direction === "forward" ? 1 : -1);

      element.scrollBy({
        behavior: "smooth",
        left: isVertical ? 0 : delta,
        top: isVertical ? delta : 0
      });
    },
    [dockPlacement]
  );

  return {
    ...magnification,
    dockFrameSize,
    dockItemsRef,
    dockMeasureRef,
    dockPlateRef,
    dockScrollState,
    registerDockSlot,
    registerWallpaperToneElement,
    scrollDockItems,
    slotRefs,
    triggerDockBounce,
    wallpaperTones
  };
}

export function isDockVisualMutationActive(
  element: HTMLElement | null
): boolean {
  if (!element) {
    return false;
  }

  return (
    element.hasAttribute("data-dock-pointer-active") ||
    element.hasAttribute("data-dock-hover-panel-open") ||
    element.querySelector(
      '[data-collapsing="true"], [data-presence="entering"], [data-presence="exiting"], [data-stack-dispatching="true"], [data-promoted-from-stack="true"]'
    ) !== null
  );
}
