export interface WorkbenchGenieViewportRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

export type WorkbenchGenieDirection = "open" | "minimize";

export interface WorkbenchGeniePoint {
  x: number;
  y: number;
}

export interface WorkbenchGenieScanlineFrame {
  direction: WorkbenchGenieDirection;
  dockPoint: WorkbenchGeniePoint;
  progress: number;
  texture: HTMLCanvasElement;
  textureRect: WorkbenchGenieViewportRect;
}

export interface WorkbenchGenieMeaningfulImageClone {
  displayHeight: number;
  displayWidth: number;
  url: string | null;
}

const genieHorizontalRowStagger = 0.65;
const genieVerticalRowStagger = 0.2;
const genieDockGlowRadius = 55;
const genieScanlineStrideThresholdPx = 640;
const genieMaxScanlineStride = 3;

export function clampGenieProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function easeInOutCubic(value: number): number {
  const progress = clampGenieProgress(value);
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

export function easeInQuadratic(value: number): number {
  const progress = clampGenieProgress(value);
  return progress * progress;
}

export function easeOutQuadratic(value: number): number {
  const progress = clampGenieProgress(value);
  return 1 - (1 - progress) * (1 - progress);
}

export function lerpGenieValue(
  from: number,
  to: number,
  progress: number
): number {
  return from + (to - from) * progress;
}

export function viewportRectFromElement(
  element: HTMLElement
): WorkbenchGenieViewportRect {
  const rect = element.getBoundingClientRect();
  return {
    height: rect.height,
    left: rect.left,
    top: rect.top,
    width: rect.width
  };
}

export function isUsableGenieRect(rect: WorkbenchGenieViewportRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function centerPointFromRect(
  rect: WorkbenchGenieViewportRect
): WorkbenchGeniePoint {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function resolveGenieScanlineStride(textureHeight: number): number {
  return Math.max(
    1,
    Math.min(
      genieMaxScanlineStride,
      Math.ceil(textureHeight / genieScanlineStrideThresholdPx)
    )
  );
}

function resolveGenieDirtyRect({
  dockPoint,
  textureRect,
  viewportHeight,
  viewportWidth
}: {
  dockPoint: WorkbenchGeniePoint;
  textureRect: WorkbenchGenieViewportRect;
  viewportHeight: number;
  viewportWidth: number;
}): WorkbenchGenieViewportRect {
  const padding = genieDockGlowRadius + 4;
  const left = Math.max(
    0,
    Math.floor(Math.min(textureRect.left, dockPoint.x) - padding)
  );
  const top = Math.max(
    0,
    Math.floor(Math.min(textureRect.top, dockPoint.y) - padding)
  );
  const right = Math.min(
    viewportWidth,
    Math.ceil(
      Math.max(textureRect.left + textureRect.width, dockPoint.x) + padding
    )
  );
  const bottom = Math.min(
    viewportHeight,
    Math.ceil(
      Math.max(textureRect.top + textureRect.height, dockPoint.y) + padding
    )
  );

  return {
    height: Math.max(0, bottom - top),
    left,
    top,
    width: Math.max(0, right - left)
  };
}

function resolveGenieRowProgress({
  direction,
  progress,
  rowProgress,
  stagger
}: {
  direction: WorkbenchGenieDirection;
  progress: number;
  rowProgress: number;
  stagger: number;
}): number {
  const start =
    direction === "minimize"
      ? (1 - rowProgress) * stagger
      : rowProgress * stagger;
  return clampGenieProgress((progress - start) / (1 - start));
}

function resolveGenieRowTargetY({
  direction,
  dockPoint,
  progress,
  sourceY,
  textureHeight,
  textureRect
}: {
  direction: WorkbenchGenieDirection;
  dockPoint: WorkbenchGeniePoint;
  progress: number;
  sourceY: number;
  textureHeight: number;
  textureRect: WorkbenchGenieViewportRect;
}): number {
  const rowProgress = clampGenieProgress(sourceY / textureHeight);
  const verticalProgress = resolveGenieRowProgress({
    direction,
    progress,
    rowProgress,
    stagger: genieVerticalRowStagger
  });
  const verticalEase = easeInQuadratic(verticalProgress);
  return direction === "minimize"
    ? lerpGenieValue(textureRect.top + sourceY, dockPoint.y, verticalEase)
    : lerpGenieValue(dockPoint.y, textureRect.top + sourceY, verticalEase);
}

export function renderGenieScanlines(
  context: CanvasRenderingContext2D,
  viewportWidth: number,
  viewportHeight: number,
  frame: WorkbenchGenieScanlineFrame
): void {
  const { direction, dockPoint, texture, textureRect } = frame;
  const progress = clampGenieProgress(frame.progress);
  const sourceWidth = Math.max(1, texture.width);
  const sourceHeight = Math.max(1, texture.height);
  const destinationWidth = Math.max(1, textureRect.width);
  const destinationHeight = Math.max(1, textureRect.height);
  const scanlineStride = resolveGenieScanlineStride(sourceHeight);
  const dirtyRect = resolveGenieDirtyRect({
    dockPoint,
    textureRect,
    viewportHeight,
    viewportWidth
  });

  context.clearRect(
    dirtyRect.left,
    dirtyRect.top,
    dirtyRect.width,
    dirtyRect.height
  );

  for (let y = 0; y < sourceHeight; y += scanlineStride) {
    const sourceSliceHeight = Math.min(scanlineStride, sourceHeight - y);
    const sourceMidY = y + sourceSliceHeight / 2;
    const rowProgress = sourceMidY / sourceHeight;
    const horizontalProgress = resolveGenieRowProgress({
      direction,
      progress,
      rowProgress,
      stagger: genieHorizontalRowStagger
    });
    const horizontalEase = easeInOutCubic(horizontalProgress);

    const left =
      direction === "minimize"
        ? lerpGenieValue(textureRect.left, dockPoint.x, horizontalEase)
        : lerpGenieValue(dockPoint.x, textureRect.left, horizontalEase);
    const right =
      direction === "minimize"
        ? lerpGenieValue(
            textureRect.left + destinationWidth,
            dockPoint.x,
            horizontalEase
          )
        : lerpGenieValue(
            dockPoint.x,
            textureRect.left + destinationWidth,
            horizontalEase
          );
    const destinationSourceTop = (y / sourceHeight) * destinationHeight;
    const destinationSourceBottom =
      ((y + sourceSliceHeight) / sourceHeight) * destinationHeight;
    const targetTop = resolveGenieRowTargetY({
      direction,
      dockPoint,
      progress,
      sourceY: destinationSourceTop,
      textureHeight: destinationHeight,
      textureRect
    });
    const targetBottom = resolveGenieRowTargetY({
      direction,
      dockPoint,
      progress,
      sourceY: destinationSourceBottom,
      textureHeight: destinationHeight,
      textureRect
    });
    const targetY = Math.min(targetTop, targetBottom) - 0.5;
    const targetHeight = Math.max(1, Math.abs(targetBottom - targetTop) + 1);
    const rowWidth = right - left;

    if (rowWidth < 0.8) {
      continue;
    }

    context.drawImage(
      texture,
      0,
      y,
      sourceWidth,
      sourceSliceHeight,
      left,
      targetY,
      rowWidth,
      targetHeight
    );
  }

  const glowProgress = direction === "minimize" ? progress : 1 - progress;
  if (glowProgress <= 0.75) {
    return;
  }

  const glowAlpha = easeOutQuadratic((glowProgress - 0.75) / 0.25) * 0.3;
  const dockGlow = context.createRadialGradient(
    dockPoint.x,
    dockPoint.y,
    0,
    dockPoint.x,
    dockPoint.y,
    genieDockGlowRadius
  );
  dockGlow.addColorStop(0, `rgba(255, 255, 255, ${glowAlpha})`);
  dockGlow.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = dockGlow;
  context.fillRect(
    dirtyRect.left,
    dirtyRect.top,
    dirtyRect.width,
    dirtyRect.height
  );
}
