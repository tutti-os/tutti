/** Keep the browser scroll range below engine layout limits. */
export const REFERENCE_SEARCH_MAX_SCROLL_HEIGHT_PX = 8_000_000;
export const REFERENCE_SEARCH_ROW_HEIGHT_PX = 58;
export const REFERENCE_SEARCH_VIRTUAL_OVERSCAN = 8;

export interface ReferenceSearchVirtualWindow {
  readonly effectiveScrollTop: number;
  readonly endIndex: number;
  readonly logicalScrollTop: number;
  readonly spacerHeight: number;
  readonly startIndex: number;
}

export function resolveReferenceSearchVirtualWindow(input: {
  itemCount: number;
  scrollTop: number;
  viewportHeight: number;
}): ReferenceSearchVirtualWindow {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const viewportHeight = Math.max(0, input.viewportHeight);
  const logicalHeight = itemCount * REFERENCE_SEARCH_ROW_HEIGHT_PX;
  const spacerHeight = Math.min(
    logicalHeight,
    REFERENCE_SEARCH_MAX_SCROLL_HEIGHT_PX
  );
  const maxEffectiveScrollTop = Math.max(0, spacerHeight - viewportHeight);
  const effectiveScrollTop = clamp(input.scrollTop, 0, maxEffectiveScrollTop);
  const maxLogicalScrollTop = Math.max(0, logicalHeight - viewportHeight);
  const logicalScrollTop =
    maxEffectiveScrollTop === 0
      ? 0
      : (effectiveScrollTop / maxEffectiveScrollTop) * maxLogicalScrollTop;
  const firstVisible = Math.floor(
    logicalScrollTop / REFERENCE_SEARCH_ROW_HEIGHT_PX
  );
  const visibleCount = Math.ceil(
    viewportHeight / REFERENCE_SEARCH_ROW_HEIGHT_PX
  );
  return {
    effectiveScrollTop,
    endIndex: Math.min(
      itemCount,
      firstVisible + visibleCount + REFERENCE_SEARCH_VIRTUAL_OVERSCAN
    ),
    logicalScrollTop,
    spacerHeight,
    startIndex: Math.max(0, firstVisible - REFERENCE_SEARCH_VIRTUAL_OVERSCAN)
  };
}

export function referenceSearchEffectiveScrollTopForLogicalPosition(input: {
  itemCount: number;
  logicalScrollTop: number;
  viewportHeight: number;
}): number {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const viewportHeight = Math.max(0, input.viewportHeight);
  const logicalHeight = itemCount * REFERENCE_SEARCH_ROW_HEIGHT_PX;
  const spacerHeight = Math.min(
    logicalHeight,
    REFERENCE_SEARCH_MAX_SCROLL_HEIGHT_PX
  );
  const maxEffectiveScrollTop = Math.max(0, spacerHeight - viewportHeight);
  const maxLogicalScrollTop = Math.max(0, logicalHeight - viewportHeight);
  if (maxLogicalScrollTop === 0) {
    return 0;
  }
  return (
    (clamp(input.logicalScrollTop, 0, maxLogicalScrollTop) /
      maxLogicalScrollTop) *
    maxEffectiveScrollTop
  );
}

export function referenceSearchVirtualRowTop(
  window: ReferenceSearchVirtualWindow,
  index: number
): number {
  return (
    window.effectiveScrollTop +
    index * REFERENCE_SEARCH_ROW_HEIGHT_PX -
    window.logicalScrollTop
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}
