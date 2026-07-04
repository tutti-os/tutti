import type { DockMagnificationSlotRect } from "./dockMagnification.ts";

export interface DockMagnificationHitBounds {
  crossEnd: number;
  crossStart: number;
  mainEnd: number;
  mainStart: number;
}

function resolveDockMagnificationViewportBounds(
  viewportRect: DockMagnificationSlotRect,
  dockPlacement: "bottom" | "left"
): DockMagnificationHitBounds {
  return dockPlacement === "left"
    ? {
        crossEnd: viewportRect.right,
        crossStart: viewportRect.left,
        mainEnd: viewportRect.bottom,
        mainStart: viewportRect.top
      }
    : {
        crossEnd: viewportRect.bottom,
        crossStart: viewportRect.top,
        mainEnd: viewportRect.right,
        mainStart: viewportRect.left
      };
}

export function resolveDockMagnificationVisibleHitBounds({
  dockPlacement,
  hitBounds,
  mainAxisEdgePadding = 0,
  viewportRect
}: {
  dockPlacement: "bottom" | "left";
  hitBounds: DockMagnificationHitBounds | null;
  mainAxisEdgePadding?: number;
  viewportRect: DockMagnificationSlotRect | null;
}): DockMagnificationHitBounds | null {
  if (!hitBounds || !viewportRect) {
    return hitBounds;
  }

  const viewportBounds = resolveDockMagnificationViewportBounds(
    viewportRect,
    dockPlacement
  );
  const visibleBounds = {
    crossEnd: Math.min(hitBounds.crossEnd, viewportBounds.crossEnd),
    crossStart: Math.max(hitBounds.crossStart, viewportBounds.crossStart),
    mainEnd: Math.min(
      hitBounds.mainEnd + mainAxisEdgePadding,
      viewportBounds.mainEnd + mainAxisEdgePadding
    ),
    mainStart: Math.max(
      hitBounds.mainStart - mainAxisEdgePadding,
      viewportBounds.mainStart - mainAxisEdgePadding
    )
  };

  if (
    visibleBounds.mainStart > visibleBounds.mainEnd ||
    visibleBounds.crossStart > visibleBounds.crossEnd
  ) {
    return null;
  }

  return visibleBounds;
}

export function resolveDockMagnificationVisibleSlotRects({
  slotRects,
  viewportRect
}: {
  slotRects: readonly DockMagnificationSlotRect[];
  viewportRect: DockMagnificationSlotRect | null;
}): DockMagnificationSlotRect[] {
  if (!viewportRect) {
    return [...slotRects];
  }

  const visibleSlotRects: DockMagnificationSlotRect[] = [];
  for (const rect of slotRects) {
    const visibleRect = {
      bottom: Math.min(rect.bottom, viewportRect.bottom),
      left: Math.max(rect.left, viewportRect.left),
      right: Math.min(rect.right, viewportRect.right),
      top: Math.max(rect.top, viewportRect.top)
    };

    if (
      visibleRect.left <= visibleRect.right &&
      visibleRect.top <= visibleRect.bottom
    ) {
      visibleSlotRects.push(visibleRect);
    }
  }

  return visibleSlotRects;
}

export function isDockMagnificationPointInsideHitBounds({
  clientX,
  clientY,
  dockPlacement,
  hitBounds
}: {
  clientX: number;
  clientY: number;
  dockPlacement: "bottom" | "left";
  hitBounds: DockMagnificationHitBounds | null;
}): boolean {
  if (!hitBounds) {
    return false;
  }

  const mainAxis = dockPlacement === "left" ? clientY : clientX;
  const crossAxis = dockPlacement === "left" ? clientX : clientY;
  return (
    mainAxis >= hitBounds.mainStart &&
    mainAxis <= hitBounds.mainEnd &&
    crossAxis >= hitBounds.crossStart &&
    crossAxis <= hitBounds.crossEnd
  );
}

export function isDockMagnificationPointInsideSlotRect({
  clientX,
  clientY,
  rect
}: {
  clientX: number;
  clientY: number;
  rect: DockMagnificationSlotRect;
}): boolean {
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}
