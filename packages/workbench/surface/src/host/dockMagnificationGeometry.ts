export const DOCK_ICON_BASE_SIZE = 43.2;
export const DOCK_ICON_PEAK_SIZE = DOCK_ICON_BASE_SIZE * 1.7;
export const DOCK_MAGNIFICATION_HALF_RANGE = DOCK_ICON_BASE_SIZE * 2.4;

export interface DockMagnificationSlotRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface DockMagnificationProjectedGeometry {
  centers: Map<string, number>;
  slotRects: DockMagnificationSlotRect[];
}

export function mapDistanceToTargetSize(
  distance: number,
  baseSize = DOCK_ICON_BASE_SIZE,
  peakSize = DOCK_ICON_PEAK_SIZE,
  halfRange = DOCK_MAGNIFICATION_HALF_RANGE
): number {
  const absoluteDistance = Math.abs(distance);
  if (absoluteDistance >= halfRange) {
    return baseSize;
  }

  const influence = 1 - absoluteDistance / halfRange;
  return baseSize + (peakSize - baseSize) * influence;
}

export function applyDockMagnificationEntryRamp(
  targetSize: number,
  baseSize: number,
  progress: number
): number {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  return baseSize + (targetSize - baseSize) * clampedProgress;
}

export function resolveDockMagnificationSlotCenter(
  rect: DockMagnificationSlotRect,
  dockPlacement: "bottom" | "left",
  baseSize = DOCK_ICON_BASE_SIZE
): number {
  return dockPlacement === "left"
    ? rect.top + baseSize / 2
    : rect.left + baseSize / 2;
}

export function projectDockMagnificationGeometry({
  appliedSizes,
  dockPlacement,
  mainAxisStartAligned,
  order,
  restRects
}: {
  appliedSizes: ReadonlyMap<string, number>;
  dockPlacement: "bottom" | "left";
  mainAxisStartAligned: boolean;
  order: readonly string[];
  restRects: ReadonlyMap<string, DockMagnificationSlotRect>;
}): DockMagnificationProjectedGeometry {
  const growthByAnchorKey = new Map<string, number>();
  let totalGrowth = 0;
  for (const anchorKey of order) {
    const restRect = restRects.get(anchorKey);
    if (!restRect) {
      continue;
    }
    const restMainSize =
      dockPlacement === "left"
        ? restRect.bottom - restRect.top
        : restRect.right - restRect.left;
    const growth = (appliedSizes.get(anchorKey) ?? restMainSize) - restMainSize;
    growthByAnchorKey.set(anchorKey, growth);
    totalGrowth += growth;
  }

  let mainAxisOffset = mainAxisStartAligned ? 0 : -totalGrowth / 2;
  const centers = new Map<string, number>();
  const slotRects: DockMagnificationSlotRect[] = [];
  for (const anchorKey of order) {
    const restRect = restRects.get(anchorKey);
    if (!restRect) {
      continue;
    }
    const growth = growthByAnchorKey.get(anchorKey) ?? 0;
    const restMainSize =
      dockPlacement === "left"
        ? restRect.bottom - restRect.top
        : restRect.right - restRect.left;
    const size = restMainSize + growth;
    const rect =
      dockPlacement === "left"
        ? {
            bottom: restRect.top + mainAxisOffset + size,
            left: (restRect.left + restRect.right - size) / 2,
            right: (restRect.left + restRect.right + size) / 2,
            top: restRect.top + mainAxisOffset
          }
        : {
            bottom: restRect.bottom,
            left: restRect.left + mainAxisOffset,
            right: restRect.left + mainAxisOffset + size,
            top: restRect.bottom - size
          };
    slotRects.push(rect);
    centers.set(
      anchorKey,
      resolveDockMagnificationSlotCenter(rect, dockPlacement)
    );
    mainAxisOffset += growth;
  }

  return { centers, slotRects };
}
