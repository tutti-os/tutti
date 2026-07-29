const FLOATING_VIEWPORT_MARGIN = 8;
const FLOATING_DRAG_THRESHOLD = 5;

export interface AnalyticsDebugPoint {
  x: number;
  y: number;
}

export interface AnalyticsDebugPosition {
  left: number;
  top: number;
}

export interface AnalyticsDebugSize {
  height: number;
  width: number;
}

export interface ResolveAnalyticsDebugFloatingPositionInput {
  floatingSize: AnalyticsDebugSize;
  pointerCurrent: AnalyticsDebugPoint;
  pointerStart: AnalyticsDebugPoint;
  startPosition: AnalyticsDebugPosition;
  viewport: AnalyticsDebugSize;
}

export function resolveAnalyticsDebugFloatingPosition({
  floatingSize,
  pointerCurrent,
  pointerStart,
  startPosition,
  viewport
}: ResolveAnalyticsDebugFloatingPositionInput): AnalyticsDebugPosition {
  return {
    left: clamp(
      startPosition.left + pointerCurrent.x - pointerStart.x,
      FLOATING_VIEWPORT_MARGIN,
      viewport.width - floatingSize.width - FLOATING_VIEWPORT_MARGIN
    ),
    top: clamp(
      startPosition.top + pointerCurrent.y - pointerStart.y,
      FLOATING_VIEWPORT_MARGIN,
      viewport.height - floatingSize.height - FLOATING_VIEWPORT_MARGIN
    )
  };
}

export function hasAnalyticsDebugFloatingDragMoved({
  pointerCurrent,
  pointerStart
}: Pick<
  ResolveAnalyticsDebugFloatingPositionInput,
  "pointerCurrent" | "pointerStart"
>): boolean {
  return (
    Math.hypot(
      pointerCurrent.x - pointerStart.x,
      pointerCurrent.y - pointerStart.y
    ) > FLOATING_DRAG_THRESHOLD
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
