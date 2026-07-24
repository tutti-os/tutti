export interface StandaloneAgentWindowContentBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface StandaloneAgentWindowWorkArea {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface ResolveStandaloneAgentWindowBoundsInput {
  minHeight: number;
  minWidth: number;
  scale: number;
  workArea: StandaloneAgentWindowWorkArea;
}

export interface ResolveStandaloneAgentWindowOffsetBoundsInput {
  offset: number;
  sourceBounds: StandaloneAgentWindowContentBounds;
  targetBounds: StandaloneAgentWindowContentBounds;
  workArea: StandaloneAgentWindowWorkArea;
}

export interface ResolveStandaloneAgentWindowWorkAreaInput {
  bottomInset: number;
  fallbackWorkArea: StandaloneAgentWindowWorkArea;
  openerBounds?: StandaloneAgentWindowWorkArea | null;
  topInset: number;
}

export function resolveStandaloneAgentWindowWorkArea({
  bottomInset,
  fallbackWorkArea,
  openerBounds,
  topInset
}: ResolveStandaloneAgentWindowWorkAreaInput): StandaloneAgentWindowWorkArea {
  if (!openerBounds) {
    return fallbackWorkArea;
  }

  const normalizedTopInset = Math.max(0, Math.round(topInset));
  const normalizedBottomInset = Math.max(0, Math.round(bottomInset));

  return {
    height: Math.max(
      1,
      Math.round(openerBounds.height) -
        normalizedTopInset -
        normalizedBottomInset
    ),
    width: Math.max(1, Math.round(openerBounds.width)),
    x: Math.round(openerBounds.x),
    y: Math.round(openerBounds.y) + normalizedTopInset
  };
}

export function shouldAnimateStandaloneAgentWindowResize(
  platform: NodeJS.Platform,
  requested = false
): boolean {
  return requested && platform === "darwin";
}

export function resolveStandaloneAgentWindowBounds({
  minHeight,
  minWidth,
  scale,
  workArea
}: ResolveStandaloneAgentWindowBoundsInput): StandaloneAgentWindowContentBounds {
  const normalizedScale =
    Number.isFinite(scale) && scale > 0 ? Math.min(scale, 1) : 1;
  const width = Math.max(
    minWidth,
    Math.round(workArea.width * normalizedScale)
  );
  const height = Math.max(
    minHeight,
    Math.round(workArea.height * normalizedScale)
  );

  return {
    height,
    width,
    x: centerAxis(workArea.x, workArea.width, width),
    y: centerAxis(workArea.y, workArea.height, height)
  };
}

export function resolveStandaloneAgentWindowOffsetBounds({
  offset,
  sourceBounds,
  targetBounds,
  workArea
}: ResolveStandaloneAgentWindowOffsetBoundsInput): StandaloneAgentWindowContentBounds {
  const normalizedOffset = Number.isFinite(offset) ? Math.round(offset) : 0;
  const minimumX = Math.round(workArea.x);
  const minimumY = Math.round(workArea.y);
  const maximumX = Math.max(
    minimumX,
    Math.round(workArea.x + workArea.width - targetBounds.width)
  );
  const maximumY = Math.max(
    minimumY,
    Math.round(workArea.y + workArea.height - targetBounds.height)
  );

  return {
    height: targetBounds.height,
    width: targetBounds.width,
    x: Math.max(
      minimumX,
      Math.min(Math.round(sourceBounds.x) + normalizedOffset, maximumX)
    ),
    y: Math.max(
      minimumY,
      Math.min(Math.round(sourceBounds.y) + normalizedOffset, maximumY)
    )
  };
}

export function resolveStandaloneAgentWindowContentWidth(input: {
  currentBounds: StandaloneAgentWindowContentBounds;
  minWidth: number;
  requestedWidth: number;
  workArea: StandaloneAgentWindowWorkArea;
}): StandaloneAgentWindowContentBounds {
  const requestedWidth = Number.isFinite(input.requestedWidth)
    ? Math.round(input.requestedWidth)
    : input.currentBounds.width;
  const width = Math.min(
    Math.max(1, Math.round(input.minWidth), requestedWidth),
    Math.max(1, Math.round(input.workArea.width))
  );
  const minimumX = input.workArea.x;
  const maximumX = input.workArea.x + input.workArea.width - width;

  return {
    height: input.currentBounds.height,
    width,
    x: Math.max(minimumX, Math.min(input.currentBounds.x, maximumX)),
    y: input.currentBounds.y
  };
}

function centerAxis(
  workAreaStart: number,
  workAreaSize: number,
  windowSize: number
): number {
  return Math.round(
    workAreaStart + Math.max(0, (workAreaSize - windowSize) / 2)
  );
}
