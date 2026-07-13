export interface FusionDockBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface FusionDockDisplay {
  id: number;
  workArea: FusionDockBounds;
}

export interface PersistedFusionDockBounds extends FusionDockBounds {
  displayId: number;
}

export interface ResolveFusionDockBoundsInput {
  defaultHeight: number;
  defaultWidth: number;
  displays: readonly FusionDockDisplay[];
  margin: number;
  persisted?: PersistedFusionDockBounds | null;
  primaryDisplay: FusionDockDisplay;
}

export interface ResolveFusionDockWidthTransitionInput {
  bounds: FusionDockBounds;
  targetWidth: number;
  workArea: FusionDockBounds;
}

export function resolveFusionDockBounds({
  defaultHeight,
  defaultWidth,
  displays,
  margin,
  persisted,
  primaryDisplay
}: ResolveFusionDockBoundsInput): PersistedFusionDockBounds {
  const display = resolveTargetDisplay(displays, persisted, primaryDisplay);
  const width = Math.min(defaultWidth, display.workArea.width);
  const height = Math.min(defaultHeight, display.workArea.height);
  const defaultX =
    display.workArea.x + Math.min(margin, display.workArea.width - width);
  const defaultY = Math.round(
    display.workArea.y + Math.max(0, (display.workArea.height - height) / 2)
  );
  const restoredX = persisted
    ? resolveFusionDockWidthTransition({
        bounds: persisted,
        targetWidth: width,
        workArea: display.workArea
      }).x
    : defaultX;

  return {
    displayId: display.id,
    height,
    width,
    x: restoredX,
    y: clampAxis(
      persisted?.y ?? defaultY,
      display.workArea.y,
      display.workArea.height,
      height
    )
  };
}

export function isPersistedFusionDockBounds(
  value: unknown
): value is PersistedFusionDockBounds {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PersistedFusionDockBounds>;
  return (
    Number.isFinite(candidate.displayId) &&
    Number.isFinite(candidate.height) &&
    Number.isFinite(candidate.width) &&
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Number(candidate.height) > 0 &&
    Number(candidate.width) > 0
  );
}

export function resolveFusionDockWidthTransition({
  bounds,
  targetWidth,
  workArea
}: ResolveFusionDockWidthTransitionInput): FusionDockBounds {
  const width = Math.min(Math.max(1, Math.round(targetWidth)), workArea.width);
  const workAreaCenterX = workArea.x + workArea.width / 2;
  const dockCenterX = bounds.x + bounds.width / 2;
  const preferredX =
    dockCenterX <= workAreaCenterX ? bounds.x : bounds.x + bounds.width - width;
  return {
    height: Math.min(bounds.height, workArea.height),
    width,
    x: clampAxis(preferredX, workArea.x, workArea.width, width),
    y: clampAxis(
      bounds.y,
      workArea.y,
      workArea.height,
      Math.min(bounds.height, workArea.height)
    )
  };
}

function resolveTargetDisplay(
  displays: readonly FusionDockDisplay[],
  persisted: PersistedFusionDockBounds | null | undefined,
  primaryDisplay: FusionDockDisplay
): FusionDockDisplay {
  if (persisted) {
    const exact = displays.find(
      (display) => display.id === persisted.displayId
    );
    if (exact) {
      return exact;
    }

    const intersecting = [...displays].sort(
      (left, right) =>
        intersectionArea(right.workArea, persisted) -
        intersectionArea(left.workArea, persisted)
    )[0];
    if (
      intersecting &&
      intersectionArea(intersecting.workArea, persisted) > 0
    ) {
      return intersecting;
    }
  }
  return primaryDisplay;
}

function intersectionArea(
  left: FusionDockBounds,
  right: FusionDockBounds
): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x)
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y)
  );
  return width * height;
}

function clampAxis(
  value: number,
  workAreaStart: number,
  workAreaSize: number,
  windowSize: number
): number {
  const maximum = workAreaStart + Math.max(0, workAreaSize - windowSize);
  return Math.round(Math.min(maximum, Math.max(workAreaStart, value)));
}
