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

export function shouldAnimateStandaloneAgentWindowResize(
  _platform: NodeJS.Platform
): boolean {
  return false;
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

export function resolveStandaloneAgentWindowContentWidth(input: {
  currentBounds: StandaloneAgentWindowContentBounds;
  requestedWidth: number;
  workArea: StandaloneAgentWindowWorkArea;
}): StandaloneAgentWindowContentBounds {
  const requestedWidth = Number.isFinite(input.requestedWidth)
    ? Math.round(input.requestedWidth)
    : input.currentBounds.width;
  const width = Math.min(
    Math.max(1, requestedWidth),
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
