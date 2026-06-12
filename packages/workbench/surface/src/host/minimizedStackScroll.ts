import type { WorkbenchDockPlacement } from "../react/types.ts";

const minimizedStackViewportMarginPx = 56;
const minimizedStackViewportCapPx = 112;
export const minimizedStackCardWidthPx = 118;
export const minimizedStackLeftPlacementGapPx = 4;
export const minimizedStackLeftDockClearancePx = 2;
export const workbenchLeftDockLeftInsetPx = 4;
export const workbenchLeftDockViewportWidthPx = 124;
export const minimizedStackLeftGutterMinPx = 4;
export const minimizedStackLeftPopupNudgeLeftPx = 60;
export const minimizedStackLeftPopupNudgeDownPx = 32;
const minimizedStackLeftGutterBufferPx = 8;
export const minimizedStackTitleTipGapPx = 12;
export const minimizedStackTitleTipMaxWidthPx = 220;
export const minimizedStackFanStepXPx = 6;
export const minimizedStackFanStepYPx = 78;
export const minimizedStackFanBaseOffsetYPx = 18;
export const minimizedStackStackPaddingPx = 96;

export function resolveMinimizedStackCardHeightPx(): number {
  return Math.round((minimizedStackCardWidthPx * 10) / 16);
}

export function resolveMinimizedStackTrackHeightPx(itemCount: number): number {
  const safeCount = Math.max(1, itemCount);
  return (
    minimizedStackFanBaseOffsetYPx +
    Math.max(0, safeCount - 1) * minimizedStackFanStepYPx +
    resolveMinimizedStackCardHeightPx() +
    minimizedStackStackPaddingPx
  );
}

export function resolveMaxMinimizedStackTrackTranslateXPx(
  itemCount: number,
  placement: WorkbenchDockPlacement
): number {
  if (placement !== "left" || itemCount <= 1) {
    return 0;
  }
  return (itemCount - 1) * minimizedStackFanStepXPx;
}

export function resolveMinimizedStackLeftGutterPx(input: {
  itemCount: number;
  placement: WorkbenchDockPlacement;
  scrollOffset?: number;
  trackHeightPx?: number;
  viewportHeightPx?: number;
  trackTranslateXPx?: number;
}): number {
  if (input.placement !== "left" || input.itemCount <= 0) {
    return 0;
  }

  if (
    input.scrollOffset === undefined ||
    input.trackHeightPx === undefined ||
    input.viewportHeightPx === undefined ||
    input.trackTranslateXPx === undefined
  ) {
    return (
      minimizedStackLeftGutterMinPx +
      resolveMaxMinimizedStackTrackTranslateXPx(
        input.itemCount,
        input.placement
      ) +
      minimizedStackLeftGutterBufferPx
    );
  }

  const cardHeightPx = resolveMinimizedStackCardHeightPx();
  const visibleTop = input.scrollOffset;
  const visibleBottom = input.scrollOffset + input.viewportHeightPx;
  let minCardLeftPx = 0;

  for (let index = 0; index < input.itemCount; index += 1) {
    const cappedIndex = Math.min(index, Math.max(0, input.itemCount - 1));
    const fanYPx =
      -minimizedStackFanBaseOffsetYPx - index * minimizedStackFanStepYPx;
    const cardTop = input.trackHeightPx + fanYPx - cardHeightPx;
    const cardBottom = input.trackHeightPx + fanYPx;
    if (cardBottom < visibleTop || cardTop > visibleBottom) {
      continue;
    }

    const fanXPx = -cappedIndex * minimizedStackFanStepXPx;
    const cardLeftPx = input.trackTranslateXPx + fanXPx;
    minCardLeftPx = Math.min(minCardLeftPx, cardLeftPx);
  }

  return Math.max(
    minimizedStackLeftGutterMinPx,
    -minCardLeftPx + minimizedStackLeftGutterBufferPx
  );
}

export function resolveMinimizedStackPanelWidthPx(
  itemCount: number,
  placement: WorkbenchDockPlacement,
  options?: { leftGutterPx?: number }
): number {
  const leftGutterPx =
    options?.leftGutterPx ??
    resolveMinimizedStackLeftGutterPx({ itemCount, placement });
  return (
    leftGutterPx +
    minimizedStackCardWidthPx +
    minimizedStackTitleTipGapPx +
    minimizedStackTitleTipMaxWidthPx
  );
}

export function resolveMinimizedStackPopupLeftPx(input: {
  anchorLeft: number;
  anchorWidth: number;
  dockRightPx?: number;
  leftGutterPx?: number;
}): number {
  const fromAnchor =
    input.anchorLeft + input.anchorWidth + minimizedStackLeftPlacementGapPx;
  const dockRight =
    input.dockRightPx ??
    workbenchLeftDockLeftInsetPx + workbenchLeftDockViewportWidthPx;
  const fromDock = dockRight + minimizedStackLeftDockClearancePx;
  const baseLeft = Math.max(fromAnchor, fromDock);
  const leftGutterPx = input.leftGutterPx ?? minimizedStackLeftGutterMinPx;
  return (
    baseLeft -
    Math.max(0, leftGutterPx - minimizedStackLeftGutterMinPx) -
    minimizedStackLeftPopupNudgeLeftPx
  );
}

export function resolveMinimizedStackPopupTopPx(input: {
  anchorTop: number;
}): number {
  return input.anchorTop + minimizedStackLeftPopupNudgeDownPx;
}

export function resolveMinimizedStackViewportHeightPx(input: {
  anchorCenterY: number;
  placement: WorkbenchDockPlacement;
  trackHeightPx: number;
  viewportHeightPx?: number;
}): number {
  const viewportCap =
    input.viewportHeightPx ??
    (typeof window === "undefined"
      ? input.trackHeightPx
      : window.innerHeight - minimizedStackViewportCapPx);

  if (input.placement === "left") {
    const availableAbove = Math.max(
      160,
      input.anchorCenterY - minimizedStackViewportMarginPx
    );
    return Math.min(input.trackHeightPx, availableAbove, viewportCap);
  }

  return Math.min(input.trackHeightPx, viewportCap);
}

export function resolveInitialMinimizedStackScrollOffset(input: {
  maxScrollOffset: number;
}): number {
  return input.maxScrollOffset;
}

export function resolveMinimizedStackFocalCardIndex(input: {
  itemCount: number;
  scrollOffset: number;
  trackHeightPx: number;
  viewportHeightPx: number;
}): number {
  if (input.itemCount <= 1) {
    return 0;
  }

  const cardHeightPx = resolveMinimizedStackCardHeightPx();
  const viewportCenterY = input.scrollOffset + input.viewportHeightPx / 2;
  const rawIndex =
    (input.trackHeightPx -
      minimizedStackFanBaseOffsetYPx -
      cardHeightPx / 2 -
      viewportCenterY) /
    minimizedStackFanStepYPx;

  return Math.min(input.itemCount - 1, Math.max(0, rawIndex));
}

export function resolveMinimizedStackFanXPx(input: {
  focalIndex: number;
  itemCount: number;
  placement: WorkbenchDockPlacement;
}): number {
  if (input.itemCount <= 0) {
    return 0;
  }

  const cappedIndex = Math.min(
    input.focalIndex,
    Math.max(0, input.itemCount - 1)
  );
  const fanDirection = input.placement === "left" ? -1 : 1;
  return cappedIndex * minimizedStackFanStepXPx * fanDirection;
}

export function resolveMinimizedStackTrackTranslateXPx(input: {
  itemCount: number;
  placement: WorkbenchDockPlacement;
  scrollOffset: number;
  trackHeightPx: number;
  viewportHeightPx: number;
}): number {
  if (input.itemCount <= 0) {
    return 0;
  }

  const focalIndex = resolveMinimizedStackFocalCardIndex({
    itemCount: input.itemCount,
    scrollOffset: input.scrollOffset,
    trackHeightPx: input.trackHeightPx,
    viewportHeightPx: input.viewportHeightPx
  });
  const fanXPx = resolveMinimizedStackFanXPx({
    focalIndex,
    itemCount: input.itemCount,
    placement: input.placement
  });

  return -fanXPx;
}
