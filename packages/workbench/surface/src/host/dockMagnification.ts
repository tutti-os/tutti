import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  isDockMagnificationPointInsideHitBounds,
  isDockMagnificationPointInsideSlotRect,
  resolveDockMagnificationHitBounds,
  resolveDockMagnificationVisibleHitBounds,
  resolveDockMagnificationVisibleSlotRects,
  type DockMagnificationHitBounds
} from "./dockMagnificationBounds.ts";
import {
  applyDockMagnificationEntryRamp,
  DOCK_ICON_BASE_SIZE,
  DOCK_MAGNIFICATION_HALF_RANGE,
  mapDistanceToTargetSize,
  projectDockMagnificationGeometry,
  type DockMagnificationSlotRect
} from "./dockMagnificationGeometry.ts";
import {
  createDockMagnificationGlobalPointerTracker,
  dockMagnificationPointerListenerOptions,
  type DockMagnificationGlobalPointerTracker
} from "./dockMagnificationPointerTracker.ts";
import {
  advanceDockMagnificationSpring,
  isDockMagnificationSpringSettled,
  type DockMagnificationSpring
} from "./dockMagnificationSpring.ts";

export {
  isDockMagnificationPointInsideHitBounds,
  isDockMagnificationPointInsideSlotRect,
  resolveDockMagnificationHitBounds,
  resolveDockMagnificationVisibleHitBounds,
  resolveDockMagnificationVisibleSlotRects,
  type DockMagnificationHitBounds
} from "./dockMagnificationBounds.ts";
export {
  applyDockMagnificationEntryRamp,
  DOCK_ICON_BASE_SIZE,
  DOCK_ICON_PEAK_SIZE,
  DOCK_MAGNIFICATION_HALF_RANGE,
  mapDistanceToTargetSize,
  projectDockMagnificationGeometry,
  resolveDockMagnificationSlotCenter,
  type DockMagnificationProjectedGeometry,
  type DockMagnificationSlotRect
} from "./dockMagnificationGeometry.ts";
export {
  createDockMagnificationGlobalPointerTracker,
  type DockMagnificationGlobalPointerTracker,
  type DockMagnificationPointerTrackingTarget
} from "./dockMagnificationPointerTracker.ts";
export {
  advanceDockMagnificationSpring,
  isDockMagnificationSpringSettled,
  type DockMagnificationSpring
} from "./dockMagnificationSpring.ts";

const MAGNIFICATION_SIZE_EPSILON = 0.2;
const MAX_MAGNIFICATION_STEP_SECONDS = 1 / 30;
const MAGNIFICATION_INFLUENCE_PADDING = 8;
const DOCK_MAGNIFICATION_ENTRY_RAMP_MS = 90;
const DOCK_MAGNIFICATION_MAIN_AXIS_EDGE_PADDING = DOCK_ICON_BASE_SIZE / 2;
const DOCK_MAGNIFICATION_AMBIENT_EDGE_RANGE = 180;
const DOCK_MAGNIFICATION_AMBIENT_VIEWPORT_PADDING = 8;

interface DockMagnificationAppliedStyle {
  size: number;
}

interface DockMagnificationGeometryBasis {
  mainAxisStartAligned: boolean;
  slotRects: Map<string, DockMagnificationSlotRect>;
  viewportRect: DockMagnificationSlotRect | null;
}

const dockMagnificationShellBySlot = new WeakMap<
  HTMLElement,
  HTMLElement | null
>();

function roundDockMagnificationSize(size: number): number {
  return Math.round(size * 10) / 10;
}

function hasAppliedSizeChanged(
  previous: DockMagnificationAppliedStyle | undefined,
  next: DockMagnificationAppliedStyle
): boolean {
  if (!previous) {
    return true;
  }

  return Math.abs(previous.size - next.size) > MAGNIFICATION_SIZE_EPSILON;
}

export function resolveDockMagnificationSlotLayoutSize({
  size
}: {
  size: number;
}): { height: number; width: number } {
  return { height: size, width: size };
}

export function isDockMagnificationSlotLayoutLocked(
  slotElement: HTMLElement
): boolean {
  return (
    slotElement.dataset.collapsing === "true" ||
    slotElement.dataset.presence === "entering" ||
    slotElement.dataset.presence === "exiting"
  );
}

function resolveDockMagnificationShell(
  slotElement: HTMLElement
): HTMLElement | null {
  const cachedShell = dockMagnificationShellBySlot.get(slotElement);
  if (
    cachedShell !== undefined &&
    (cachedShell === null || slotElement.contains(cachedShell))
  ) {
    return cachedShell;
  }

  const shell =
    slotElement.querySelector<HTMLElement>("[data-desktop-dock-icon-shell]") ??
    slotElement.querySelector<HTMLElement>(
      ".desktop-dock__minimized-preview"
    ) ??
    slotElement.querySelector<HTMLElement>(
      ".desktop-dock__minimized-stack-icon"
    );
  dockMagnificationShellBySlot.set(slotElement, shell);
  return shell;
}

function applyDockSlotMagnification(
  slotElement: HTMLElement,
  size: number,
  baseSize: number,
  appliedStylesRef: Map<string, DockMagnificationAppliedStyle>
): void {
  const anchorKey = slotElement.dataset.desktopDockAnchorKey;
  if (!anchorKey) {
    return;
  }

  const shell = resolveDockMagnificationShell(slotElement);
  if (!shell) {
    return;
  }

  const nextStyle = {
    size: roundDockMagnificationSize(size)
  };

  if (!hasAppliedSizeChanged(appliedStylesRef.get(anchorKey), nextStyle)) {
    return;
  }

  appliedStylesRef.set(anchorKey, nextStyle);

  if (Math.abs(nextStyle.size - baseSize) <= MAGNIFICATION_SIZE_EPSILON) {
    slotElement.style.removeProperty("width");
    slotElement.style.removeProperty("height");
    shell.style.removeProperty("transform");
    return;
  }

  const scale = nextStyle.size / baseSize;
  const layoutSize = resolveDockMagnificationSlotLayoutSize({
    size: nextStyle.size
  });
  slotElement.style.width = `${layoutSize.width}px`;
  slotElement.style.height = `${layoutSize.height}px`;
  shell.style.transform = `scale(${scale})`;
}

function clearDockSlotMagnification(
  slotElement: HTMLElement,
  appliedStylesRef: Map<string, DockMagnificationAppliedStyle>
): void {
  const anchorKey = slotElement.dataset.desktopDockAnchorKey;
  if (anchorKey) {
    appliedStylesRef.delete(anchorKey);
  }
  slotElement.style.removeProperty("width");
  slotElement.style.removeProperty("height");
  const shell = resolveDockMagnificationShell(slotElement);
  shell?.style.removeProperty("transform");
}

function isPointNearDockScreenEdge({
  clientX,
  clientY,
  dockPlacement
}: {
  clientX: number;
  clientY: number;
  dockPlacement: "bottom" | "left";
}): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  return dockPlacement === "left"
    ? clientX <= DOCK_MAGNIFICATION_AMBIENT_EDGE_RANGE
    : window.innerHeight - clientY <= DOCK_MAGNIFICATION_AMBIENT_EDGE_RANGE;
}

function isPointNearDockViewport({
  clientX,
  clientY,
  dockPlacement,
  viewportRect
}: {
  clientX: number;
  clientY: number;
  dockPlacement: "bottom" | "left";
  viewportRect: DockMagnificationSlotRect;
}): boolean {
  const horizontalPadding =
    dockPlacement === "bottom"
      ? DOCK_MAGNIFICATION_MAIN_AXIS_EDGE_PADDING
      : DOCK_MAGNIFICATION_AMBIENT_VIEWPORT_PADDING;
  const verticalPadding =
    dockPlacement === "left"
      ? DOCK_MAGNIFICATION_MAIN_AXIS_EDGE_PADDING
      : DOCK_MAGNIFICATION_AMBIENT_VIEWPORT_PADDING;

  return (
    clientX >= viewportRect.left - horizontalPadding &&
    clientX <= viewportRect.right + horizontalPadding &&
    clientY >= viewportRect.top - verticalPadding &&
    clientY <= viewportRect.bottom + verticalPadding
  );
}

export function useDockMagnification({
  dockPlateRef,
  dockPlacement,
  dockRootRef,
  dockViewportRef,
  slotRefs
}: {
  dockPlateRef: RefObject<HTMLElement | null>;
  dockPlacement: "bottom" | "left";
  dockRootRef: RefObject<HTMLElement | null>;
  dockViewportRef: RefObject<HTMLElement | null>;
  slotRefs: RefObject<Map<string, HTMLElement>>;
}) {
  const pointerAxisRef = useRef<number | null>(null);
  const pendingPointerAxisRef = useRef<number | null>(null);
  const springsRef = useRef(new Map<string, DockMagnificationSpring>());
  const appliedStylesRef = useRef(
    new Map<string, DockMagnificationAppliedStyle>()
  );
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const entryRampStartedAtRef = useRef<number | null>(null);
  const centersRef = useRef<Map<string, number> | null>(null);
  const hitBoundsRef = useRef<DockMagnificationHitBounds | null>(null);
  const visibleSlotRectsRef = useRef<DockMagnificationSlotRect[] | null>(null);
  const slotOrderRef = useRef<string[]>([]);
  const geometryBasisRef = useRef<DockMagnificationGeometryBasis | null>(null);
  const magnifyActiveRef = useRef(false);
  const globalPointerTrackerRef =
    useRef<DockMagnificationGlobalPointerTracker | null>(null);
  const handleGlobalPointerMoveRef = useRef<
    (clientX: number, clientY: number) => void
  >(() => {
    return;
  });
  const handleGlobalPointerCancelRef = useRef<() => void>(() => {
    return;
  });

  const setMagnifyActive = useCallback(
    (active: boolean) => {
      if (magnifyActiveRef.current === active) {
        return;
      }
      magnifyActiveRef.current = active;
      if (active) {
        dockPlateRef.current?.setAttribute("data-dock-pointer-active", "true");
        dockRootRef.current?.setAttribute("data-dock-pointer-active", "true");
      } else {
        dockPlateRef.current?.removeAttribute("data-dock-pointer-active");
        dockRootRef.current?.removeAttribute("data-dock-pointer-active");
      }
    },
    [dockPlateRef, dockRootRef]
  );

  const stopAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    lastFrameTimeRef.current = null;
  }, []);

  const updateProjectedGeometry = useCallback(() => {
    const basis = geometryBasisRef.current;
    if (!basis) {
      return;
    }
    const appliedSizes = new Map<string, number>();
    for (const [anchorKey, style] of appliedStylesRef.current) {
      appliedSizes.set(anchorKey, style.size);
    }
    const geometry = projectDockMagnificationGeometry({
      appliedSizes,
      dockPlacement,
      mainAxisStartAligned: basis.mainAxisStartAligned,
      order: slotOrderRef.current,
      restRects: basis.slotRects
    });
    hitBoundsRef.current = resolveDockMagnificationVisibleHitBounds({
      dockPlacement,
      hitBounds: resolveDockMagnificationHitBounds(
        geometry.slotRects,
        dockPlacement
      ),
      mainAxisEdgePadding: DOCK_MAGNIFICATION_MAIN_AXIS_EDGE_PADDING,
      viewportRect: basis.viewportRect
    });
    visibleSlotRectsRef.current = resolveDockMagnificationVisibleSlotRects({
      slotRects: geometry.slotRects,
      viewportRect: basis.viewportRect
    });
    centersRef.current = geometry.centers;
  }, [dockPlacement]);

  const captureBaseGeometry = useCallback(() => {
    const slots = slotRefs.current;
    const slotRects = new Map<string, DockMagnificationSlotRect>();
    const order: string[] = [];
    const viewportRect = dockViewportRef.current?.getBoundingClientRect();
    for (const [anchorKey, slotElement] of slots) {
      order.push(anchorKey);
      const rect = slotElement.getBoundingClientRect();
      slotRects.set(anchorKey, {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top
      });
    }
    slotOrderRef.current = order;
    const visibleViewportRect = viewportRect
      ? {
          bottom: viewportRect.bottom,
          left: viewportRect.left,
          right: viewportRect.right,
          top: viewportRect.top
        }
      : null;
    geometryBasisRef.current = {
      mainAxisStartAligned:
        dockRootRef.current?.hasAttribute("data-scroll-overflow") ?? false,
      slotRects,
      viewportRect: visibleViewportRect
    };
    updateProjectedGeometry();
  }, [dockRootRef, dockViewportRef, slotRefs, updateProjectedGeometry]);

  const isPointerInsideAnyVisibleDockSlot = useCallback(
    (clientX: number, clientY: number): boolean => {
      for (const rect of visibleSlotRectsRef.current ?? []) {
        if (
          isDockMagnificationPointInsideSlotRect({
            clientX,
            clientY,
            rect
          })
        ) {
          return true;
        }
      }
      return false;
    },
    []
  );

  const ensureDockMagnificationGeometry = useCallback(() => {
    if (
      centersRef.current === null ||
      hitBoundsRef.current === null ||
      visibleSlotRectsRef.current === null
    ) {
      captureBaseGeometry();
    }
  }, [captureBaseGeometry]);

  const isPointerInsideDockMagnificationTarget = useCallback(
    (clientX: number, clientY: number): boolean =>
      isDockMagnificationPointInsideHitBounds({
        clientX,
        clientY,
        dockPlacement,
        hitBounds: hitBoundsRef.current
      }) || isPointerInsideAnyVisibleDockSlot(clientX, clientY),
    [dockPlacement, isPointerInsideAnyVisibleDockSlot]
  );

  const runAnimationFrame = useCallback(
    (frameTime: number) => {
      if (pendingPointerAxisRef.current !== null) {
        pointerAxisRef.current = pendingPointerAxisRef.current;
      }

      const pointerAxis = pointerAxisRef.current;
      if (pointerAxis !== null) {
        entryRampStartedAtRef.current ??= frameTime;
      }
      const slots = slotRefs.current;
      const order = slotOrderRef.current;
      const previousFrameTime = lastFrameTimeRef.current;
      lastFrameTimeRef.current = frameTime;
      const deltaSeconds =
        previousFrameTime === null
          ? 1 / 60
          : Math.min(
              (frameTime - previousFrameTime) / 1000,
              MAX_MAGNIFICATION_STEP_SECONDS
            );

      let shouldContinue = false;
      let allSettled = true;
      const influenceRadius =
        DOCK_MAGNIFICATION_HALF_RANGE + MAGNIFICATION_INFLUENCE_PADDING;
      const entryRampProgress =
        pointerAxis === null || entryRampStartedAtRef.current === null
          ? 1
          : (frameTime - entryRampStartedAtRef.current) /
            DOCK_MAGNIFICATION_ENTRY_RAMP_MS;

      for (let index = 0; index < order.length; index += 1) {
        const anchorKey = order[index];
        if (!anchorKey) {
          continue;
        }

        const center = centersRef.current?.get(anchorKey);
        if (center === undefined) {
          continue;
        }

        const distance =
          pointerAxis === null
            ? DOCK_MAGNIFICATION_HALF_RANGE
            : pointerAxis - center;
        const absoluteDistance = Math.abs(distance);
        const inRange = absoluteDistance < influenceRadius;
        const targetSize = inRange
          ? applyDockMagnificationEntryRamp(
              mapDistanceToTargetSize(distance),
              DOCK_ICON_BASE_SIZE,
              entryRampProgress
            )
          : DOCK_ICON_BASE_SIZE;

        const currentSpring = springsRef.current.get(anchorKey) ?? {
          value: DOCK_ICON_BASE_SIZE,
          velocity: 0
        };
        const nextSpring =
          inRange ||
          !isDockMagnificationSpringSettled(currentSpring, DOCK_ICON_BASE_SIZE)
            ? advanceDockMagnificationSpring(
                currentSpring,
                targetSize,
                deltaSeconds
              )
            : currentSpring;

        if (
          !inRange &&
          isDockMagnificationSpringSettled(nextSpring, DOCK_ICON_BASE_SIZE)
        ) {
          springsRef.current.delete(anchorKey);
          const slotElement = slots.get(anchorKey);
          if (slotElement) {
            clearDockSlotMagnification(slotElement, appliedStylesRef.current);
          }
          continue;
        }

        springsRef.current.set(anchorKey, nextSpring);

        const settled = isDockMagnificationSpringSettled(
          nextSpring,
          targetSize
        );
        if (!settled) {
          shouldContinue = true;
        }
        if (
          !isDockMagnificationSpringSettled(nextSpring, DOCK_ICON_BASE_SIZE)
        ) {
          allSettled = false;
        }

        const slotElement = slots.get(anchorKey);
        if (!slotElement) {
          continue;
        }

        if (isDockMagnificationSlotLayoutLocked(slotElement)) {
          springsRef.current.delete(anchorKey);
          clearDockSlotMagnification(slotElement, appliedStylesRef.current);
          continue;
        }

        if (
          pointerAxis === null &&
          isDockMagnificationSpringSettled(nextSpring, DOCK_ICON_BASE_SIZE)
        ) {
          springsRef.current.delete(anchorKey);
          clearDockSlotMagnification(slotElement, appliedStylesRef.current);
          continue;
        }

        applyDockSlotMagnification(
          slotElement,
          nextSpring.value,
          DOCK_ICON_BASE_SIZE,
          appliedStylesRef.current
        );
      }
      updateProjectedGeometry();

      if (pointerAxis !== null) {
        shouldContinue = true;
      } else if (!allSettled) {
        shouldContinue = true;
      }

      if (pointerAxis === null && allSettled) {
        entryRampStartedAtRef.current = null;
        centersRef.current = null;
        hitBoundsRef.current = null;
        visibleSlotRectsRef.current = null;
        slotOrderRef.current = [];
        geometryBasisRef.current = null;
        setMagnifyActive(false);
      }

      if (shouldContinue) {
        animationFrameRef.current = requestAnimationFrame(runAnimationFrame);
        return;
      }

      animationFrameRef.current = null;
      lastFrameTimeRef.current = null;
    },
    [setMagnifyActive, slotRefs, updateProjectedGeometry]
  );

  const scheduleAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      return;
    }
    animationFrameRef.current = requestAnimationFrame(runAnimationFrame);
  }, [runAnimationFrame]);

  const stopGlobalPointerTracking = useCallback(() => {
    globalPointerTrackerRef.current?.stop();
  }, []);

  const startGlobalPointerTracking = useCallback(() => {
    if (typeof document === "undefined") {
      return;
    }

    globalPointerTrackerRef.current ??=
      createDockMagnificationGlobalPointerTracker({
        blurTarget: typeof window === "undefined" ? null : window,
        onPointerCancel: () => {
          handleGlobalPointerCancelRef.current();
        },
        onPointerMove: (clientX, clientY) => {
          handleGlobalPointerMoveRef.current(clientX, clientY);
        },
        pointerTarget: document
      });
    globalPointerTrackerRef.current.start();
  }, []);

  const clearTrackedPointer = useCallback(() => {
    pendingPointerAxisRef.current = null;
    pointerAxisRef.current = null;
    entryRampStartedAtRef.current = null;
    scheduleAnimation();
  }, [scheduleAnimation]);

  const handleGlobalPointerCancel = useCallback(() => {
    stopGlobalPointerTracking();
    clearTrackedPointer();
  }, [clearTrackedPointer, stopGlobalPointerTracking]);

  const handlePointerMove = useCallback(
    (clientX: number, clientY: number) => {
      ensureDockMagnificationGeometry();

      if (!isPointerInsideDockMagnificationTarget(clientX, clientY)) {
        stopGlobalPointerTracking();
        clearTrackedPointer();
        return;
      }

      pendingPointerAxisRef.current =
        dockPlacement === "left" ? clientY : clientX;
      if (!magnifyActiveRef.current) {
        setMagnifyActive(true);
      }
      startGlobalPointerTracking();
      scheduleAnimation();
    },
    [
      clearTrackedPointer,
      dockPlacement,
      ensureDockMagnificationGeometry,
      isPointerInsideDockMagnificationTarget,
      scheduleAnimation,
      setMagnifyActive,
      startGlobalPointerTracking,
      stopGlobalPointerTracking
    ]
  );
  handleGlobalPointerMoveRef.current = handlePointerMove;
  handleGlobalPointerCancelRef.current = handleGlobalPointerCancel;

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    let animationFrame: number | null = null;
    let latestPoint: { clientX: number; clientY: number } | null = null;

    const clearAmbientPointerSample = () => {
      latestPoint = null;
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
    };

    const runAmbientPointerMove = () => {
      animationFrame = null;
      const point = latestPoint;
      latestPoint = null;
      if (!point || magnifyActiveRef.current) {
        return;
      }

      const viewportRect = dockViewportRef.current?.getBoundingClientRect();
      if (!viewportRect) {
        return;
      }
      const visibleViewportRect = {
        bottom: viewportRect.bottom,
        left: viewportRect.left,
        right: viewportRect.right,
        top: viewportRect.top
      };
      if (
        !isPointNearDockViewport({
          clientX: point.clientX,
          clientY: point.clientY,
          dockPlacement,
          viewportRect: visibleViewportRect
        })
      ) {
        return;
      }

      ensureDockMagnificationGeometry();
      if (
        isPointerInsideDockMagnificationTarget(point.clientX, point.clientY)
      ) {
        handlePointerMove(point.clientX, point.clientY);
      }
    };

    const handleAmbientPointerMove = (event: PointerEvent) => {
      if (magnifyActiveRef.current) {
        clearAmbientPointerSample();
        return;
      }
      if (
        !isPointNearDockScreenEdge({
          clientX: event.clientX,
          clientY: event.clientY,
          dockPlacement
        })
      ) {
        clearAmbientPointerSample();
        return;
      }
      latestPoint = { clientX: event.clientX, clientY: event.clientY };
      if (animationFrame === null) {
        animationFrame = requestAnimationFrame(runAmbientPointerMove);
      }
    };

    document.addEventListener(
      "pointermove",
      handleAmbientPointerMove,
      dockMagnificationPointerListenerOptions
    );
    return () => {
      document.removeEventListener(
        "pointermove",
        handleAmbientPointerMove,
        dockMagnificationPointerListenerOptions
      );
      clearAmbientPointerSample();
    };
  }, [
    dockPlacement,
    dockViewportRef,
    ensureDockMagnificationGeometry,
    handlePointerMove,
    isPointerInsideDockMagnificationTarget
  ]);

  const handlePointerLeave = useCallback(() => {
    pendingPointerAxisRef.current = null;
    pointerAxisRef.current = null;
    scheduleAnimation();
  }, [scheduleAnimation]);

  const clearSlotMagnification = useCallback(
    (anchorKey: string) => {
      springsRef.current.delete(anchorKey);
      centersRef.current = null;
      appliedStylesRef.current.delete(anchorKey);
      hitBoundsRef.current = null;
      visibleSlotRectsRef.current = null;
      geometryBasisRef.current = null;
      slotOrderRef.current = slotOrderRef.current.filter(
        (key) => key !== anchorKey
      );
      const slotElement = slotRefs.current.get(anchorKey);
      if (slotElement) {
        clearDockSlotMagnification(slotElement, appliedStylesRef.current);
      }
    },
    [slotRefs]
  );

  const pauseMagnification = useCallback(() => {
    stopGlobalPointerTracking();
    stopAnimation();
    pendingPointerAxisRef.current = null;
    pointerAxisRef.current = null;
    entryRampStartedAtRef.current = null;
    lastFrameTimeRef.current = null;
  }, [stopAnimation, stopGlobalPointerTracking]);

  const resetMagnification = useCallback(() => {
    stopGlobalPointerTracking();
    stopAnimation();
    for (const slotElement of slotRefs.current.values()) {
      clearDockSlotMagnification(slotElement, appliedStylesRef.current);
    }
    springsRef.current.clear();
    appliedStylesRef.current.clear();
    centersRef.current = null;
    hitBoundsRef.current = null;
    visibleSlotRectsRef.current = null;
    slotOrderRef.current = [];
    geometryBasisRef.current = null;
    pointerAxisRef.current = null;
    pendingPointerAxisRef.current = null;
    entryRampStartedAtRef.current = null;
    setMagnifyActive(false);
  }, [setMagnifyActive, slotRefs, stopAnimation, stopGlobalPointerTracking]);

  useEffect(
    () => () => {
      resetMagnification();
    },
    [resetMagnification]
  );

  return {
    clearSlotMagnification,
    handlePointerLeave,
    handlePointerMove,
    pauseMagnification,
    resetMagnification
  };
}
