export interface DesktopWindowWorkArea {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface DesktopWindowBounds extends DesktopWindowWorkArea {}

export interface ResolveCenteredWindowBoundsInput {
  defaultHeight: number;
  defaultWidth: number;
  margin: number;
  minHeight: number;
  minWidth: number;
  workArea: DesktopWindowWorkArea;
}

export function resolveCenteredWindowBounds({
  defaultHeight,
  defaultWidth,
  margin,
  minHeight,
  minWidth,
  workArea
}: ResolveCenteredWindowBoundsInput): DesktopWindowBounds {
  const width = resolveWindowSize(
    defaultWidth,
    minWidth,
    workArea.width,
    margin
  );
  const height = resolveWindowSize(
    defaultHeight,
    minHeight,
    workArea.height,
    margin
  );

  return {
    height,
    width,
    x: centerAxis(workArea.x, workArea.width, width),
    y: centerAxis(workArea.y, workArea.height, height)
  };
}

function resolveWindowSize(
  defaultSize: number,
  minSize: number,
  workAreaSize: number,
  margin: number
): number {
  const availableSize = Math.max(minSize, workAreaSize - margin * 2);
  return Math.min(defaultSize, availableSize);
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
