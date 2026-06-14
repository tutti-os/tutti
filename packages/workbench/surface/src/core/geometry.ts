import {
  defaultWorkbenchLayoutConstraints,
  type WorkbenchFrame,
  type WorkbenchLayoutPreset,
  type WorkbenchLayoutConstraints,
  type WorkbenchLayoutConstraintsInput,
  type WorkbenchNodeSizeConstraints,
  type WorkbenchQuickLayoutTarget,
  type WorkbenchSafeArea,
  type WorkbenchSize,
  type WorkbenchSnapTarget
} from "./types.ts";

export const WORKBENCH_MIN_VISIBLE_PX = 40;
export const WORKBENCH_LAYOUT_PRESET_GAP_PX = 12;

export function normalizeWorkbenchLayoutConstraints(
  constraints: WorkbenchLayoutConstraintsInput = {}
): WorkbenchLayoutConstraints {
  return {
    minWidth:
      constraints.minWidth ?? defaultWorkbenchLayoutConstraints.minWidth,
    minHeight:
      constraints.minHeight ?? defaultWorkbenchLayoutConstraints.minHeight,
    surfacePadding:
      constraints.surfacePadding ??
      defaultWorkbenchLayoutConstraints.surfacePadding,
    safeArea: normalizeWorkbenchSafeArea(constraints.safeArea)
  };
}

export function normalizeWorkbenchSafeArea(
  safeArea: Partial<WorkbenchSafeArea> = {}
): WorkbenchSafeArea {
  return {
    top: Math.max(0, safeArea.top ?? 0),
    right: Math.max(0, safeArea.right ?? 0),
    bottom: Math.max(0, safeArea.bottom ?? 0),
    left: Math.max(0, safeArea.left ?? 0)
  };
}

export function getWorkbenchLayoutFrame(
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints
): WorkbenchFrame {
  const normalized = normalizeWorkbenchLayoutConstraints(constraints);
  const width = Math.max(
    normalized.minWidth,
    surfaceSize.width - normalized.safeArea.left - normalized.safeArea.right
  );
  const height = Math.max(
    normalized.minHeight,
    surfaceSize.height - normalized.safeArea.top - normalized.safeArea.bottom
  );

  return {
    x: normalized.safeArea.left,
    y: normalized.safeArea.top,
    width,
    height
  };
}

export function clampWorkbenchRect(
  rect: WorkbenchFrame,
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints,
  sizeConstraints?: WorkbenchNodeSizeConstraints | null
): WorkbenchFrame {
  const normalized = resolveWorkbenchRectConstraints(
    constraints,
    sizeConstraints
  );
  const frame = getWorkbenchLayoutFrame(surfaceSize, normalized);
  const width = clamp(
    rect.width,
    normalized.minWidth,
    Math.max(normalized.minWidth, frame.width - normalized.surfacePadding * 2)
  );
  const height = clamp(
    rect.height,
    normalized.minHeight,
    Math.max(normalized.minHeight, frame.height - normalized.surfacePadding * 2)
  );
  const maxX = Math.max(
    frame.x + normalized.surfacePadding,
    frame.x + frame.width - width - normalized.surfacePadding
  );
  const maxY = Math.max(
    frame.y + normalized.surfacePadding,
    frame.y + frame.height - height - normalized.surfacePadding
  );

  return {
    x: clamp(rect.x, frame.x + normalized.surfacePadding, maxX),
    y: clamp(rect.y, frame.y + normalized.surfacePadding, maxY),
    width,
    height
  };
}

export function clampWorkbenchRectToVisibleArea(
  rect: WorkbenchFrame,
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints,
  minVisiblePx = WORKBENCH_MIN_VISIBLE_PX,
  sizeConstraints?: WorkbenchNodeSizeConstraints | null
): WorkbenchFrame {
  const normalized = resolveWorkbenchRectConstraints(
    constraints,
    sizeConstraints
  );
  const visibleFrame = getWorkbenchSafeLayoutRect(surfaceSize, normalized);
  const sizedRect = clampWorkbenchRect(
    {
      ...rect,
      x: visibleFrame.x,
      y: visibleFrame.y
    },
    surfaceSize,
    normalized
  );
  const minVisibleX = Math.min(minVisiblePx, visibleFrame.width);
  const minVisibleY = Math.min(minVisiblePx, visibleFrame.height);
  const minX = visibleFrame.x + minVisibleX - sizedRect.width;
  const maxX = visibleFrame.x + visibleFrame.width - minVisibleX;
  const minY = visibleFrame.y + minVisibleY - sizedRect.height;
  const maxY = visibleFrame.y + visibleFrame.height - minVisibleY;

  return {
    ...sizedRect,
    x: Math.round(clamp(rect.x, minX, maxX)),
    y: Math.round(clamp(rect.y, minY, maxY))
  };
}

export function clampWorkbenchDragRect(
  rect: WorkbenchFrame,
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints,
  sizeConstraints?: WorkbenchNodeSizeConstraints | null
): WorkbenchFrame {
  const normalized = resolveWorkbenchRectConstraints(
    constraints,
    sizeConstraints
  );
  const layoutFrame = getWorkbenchLayoutFrame(surfaceSize, normalized);
  const visibleRect = clampWorkbenchRectToVisibleArea(
    rect,
    surfaceSize,
    normalized,
    WORKBENCH_MIN_VISIBLE_PX
  );

  return {
    ...visibleRect,
    y: Math.max(layoutFrame.y + normalized.surfacePadding, visibleRect.y)
  };
}

export function getWorkbenchFullscreenRect(
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints,
  sizeConstraints?: WorkbenchNodeSizeConstraints | null
): WorkbenchFrame {
  const normalized = resolveWorkbenchRectConstraints(
    constraints,
    sizeConstraints
  );
  const fullscreenSafeArea = {
    ...normalized.safeArea,
    bottom: 0,
    left: 0
  };
  return {
    x: fullscreenSafeArea.left + normalized.surfacePadding,
    y: fullscreenSafeArea.top + normalized.surfacePadding,
    width: Math.max(
      normalized.minWidth,
      surfaceSize.width -
        fullscreenSafeArea.left -
        fullscreenSafeArea.right -
        normalized.surfacePadding * 2
    ),
    height: Math.max(
      normalized.minHeight,
      surfaceSize.height -
        fullscreenSafeArea.top -
        fullscreenSafeArea.bottom -
        normalized.surfacePadding * 2
    )
  };
}

export function getWorkbenchSnapRect(
  snapTarget: WorkbenchSnapTarget,
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints,
  sizeConstraints?: WorkbenchNodeSizeConstraints | null
): WorkbenchFrame | null {
  const normalized = resolveWorkbenchRectConstraints(
    constraints,
    sizeConstraints
  );
  const full = getWorkbenchSafeLayoutRect(surfaceSize, normalized);
  const clampSnapRect = (rect: WorkbenchFrame): WorkbenchFrame =>
    clampWorkbenchRect(rect, surfaceSize, normalized);
  if (snapTarget === "left") {
    return clampSnapRect({ ...full, width: Math.round(full.width / 2) });
  }
  if (snapTarget === "right") {
    const width = Math.round(full.width / 2);
    return clampSnapRect({ ...full, x: full.x + full.width - width, width });
  }
  if (snapTarget === "top") {
    return clampSnapRect(full);
  }
  return null;
}

export function getWorkbenchQuickLayoutRect(
  target: WorkbenchQuickLayoutTarget,
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints,
  sizeConstraints?: WorkbenchNodeSizeConstraints | null
): WorkbenchFrame {
  const normalized = resolveWorkbenchRectConstraints(
    constraints,
    sizeConstraints
  );
  const full = getWorkbenchSafeLayoutRect(surfaceSize, normalized);
  const clampQuickLayoutRect = (rect: WorkbenchFrame): WorkbenchFrame =>
    clampWorkbenchRect(rect, surfaceSize, normalized);

  switch (target) {
    case "left":
      return clampQuickLayoutRect({
        ...full,
        width: Math.round(full.width / 4)
      });
    case "right": {
      const width = Math.round(full.width / 4);
      return clampQuickLayoutRect({
        ...full,
        x: full.x + full.width - width,
        width
      });
    }
    case "top":
      return clampQuickLayoutRect({
        ...full,
        height: Math.round(full.height / 2)
      });
    case "bottom": {
      const height = Math.round(full.height / 2);
      return clampQuickLayoutRect({
        ...full,
        y: full.y + full.height - height,
        height
      });
    }
  }
}

function resolveWorkbenchRectConstraints(
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints,
  sizeConstraints?: WorkbenchNodeSizeConstraints | null
): WorkbenchLayoutConstraints {
  const normalized = normalizeWorkbenchLayoutConstraints(constraints);
  return {
    ...normalized,
    minHeight: Math.max(
      normalized.minHeight,
      normalizeNodeMinimum(sizeConstraints?.minHeight)
    ),
    minWidth: Math.max(
      normalized.minWidth,
      normalizeNodeMinimum(sizeConstraints?.minWidth)
    )
  };
}

function normalizeNodeMinimum(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function getWorkbenchLayoutPresetFrames(
  itemCount: number,
  preset: WorkbenchLayoutPreset,
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints
): WorkbenchFrame[] | null {
  if (itemCount <= 0) {
    return [];
  }

  const normalized = normalizeWorkbenchLayoutConstraints(constraints);
  const frame = getWorkbenchSafeLayoutRect(surfaceSize, normalized);
  switch (preset.kind) {
    case "balanced":
      return getBalancedLayoutFrames(itemCount, frame, normalized);
    case "row":
      return getGridLayoutFrames(itemCount, itemCount, frame, normalized);
    case "column":
      return getSingleColumnLayoutFrames(itemCount, frame, normalized);
  }
}

function getWorkbenchSafeLayoutRect(
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints
): WorkbenchFrame {
  const normalized = normalizeWorkbenchLayoutConstraints(constraints);
  const frame = getWorkbenchLayoutFrame(surfaceSize, normalized);
  return {
    x: frame.x + normalized.surfacePadding,
    y: frame.y + normalized.surfacePadding,
    width: Math.max(
      normalized.minWidth,
      frame.width - normalized.surfacePadding * 2
    ),
    height: Math.max(
      normalized.minHeight,
      frame.height - normalized.surfacePadding * 2
    )
  };
}

export function inferWorkbenchSnapTarget(
  dragPoint: Pick<WorkbenchFrame, "y">,
  surfaceSize: WorkbenchSize,
  threshold = 0,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints
): WorkbenchSnapTarget {
  const frame = getWorkbenchLayoutFrame(surfaceSize, constraints);
  const topSnapBoundary = frame.y - threshold;
  if (
    dragPoint.y < topSnapBoundary ||
    (topSnapBoundary === 0 && dragPoint.y <= 0)
  ) {
    return "top";
  }
  return null;
}

export function rectsEqual(
  left: WorkbenchFrame,
  right: WorkbenchFrame
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getGridLayoutFrames(
  itemCount: number,
  columns: number,
  frame: WorkbenchFrame,
  constraints: WorkbenchLayoutConstraints
): WorkbenchFrame[] | null {
  const rows = Math.ceil(itemCount / columns);
  const horizontalGap =
    WORKBENCH_LAYOUT_PRESET_GAP_PX * Math.max(0, columns - 1);
  const verticalGap = WORKBENCH_LAYOUT_PRESET_GAP_PX * Math.max(0, rows - 1);
  const cellWidth = Math.floor((frame.width - horizontalGap) / columns);
  const cellHeight = Math.floor((frame.height - verticalGap) / rows);

  if (cellWidth < constraints.minWidth || cellHeight < constraints.minHeight) {
    return null;
  }

  const contentHeight =
    rows * cellHeight + (rows - 1) * WORKBENCH_LAYOUT_PRESET_GAP_PX;
  let index = 0;
  const frames: WorkbenchFrame[] = [];

  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const remaining = itemCount - index;
    const itemsInRow = Math.min(columns, remaining);
    const rowWidth =
      itemsInRow * cellWidth +
      Math.max(0, itemsInRow - 1) * WORKBENCH_LAYOUT_PRESET_GAP_PX;
    const rowX = frame.x + Math.round((frame.width - rowWidth) / 2);
    const rowY =
      frame.y +
      Math.round((frame.height - contentHeight) / 2) +
      rowIndex * (cellHeight + WORKBENCH_LAYOUT_PRESET_GAP_PX);

    for (let columnIndex = 0; columnIndex < itemsInRow; columnIndex += 1) {
      frames.push({
        x: rowX + columnIndex * (cellWidth + WORKBENCH_LAYOUT_PRESET_GAP_PX),
        y: rowY,
        width: cellWidth,
        height: cellHeight
      });
      index += 1;
    }
  }

  return frames;
}

function getBalancedLayoutFrames(
  itemCount: number,
  frame: WorkbenchFrame,
  constraints: WorkbenchLayoutConstraints
): WorkbenchFrame[] | null {
  if (itemCount === 1) {
    return [frame];
  }

  if (itemCount === 2) {
    return getGridLayoutFrames(itemCount, 2, frame, constraints);
  }

  if (itemCount >= 4) {
    return getBestBalancedGridLayoutFrames(itemCount, frame, constraints);
  }

  const gap = WORKBENCH_LAYOUT_PRESET_GAP_PX;
  const primaryWidth = Math.floor((frame.width - gap) * 0.58);
  const secondaryWidth = frame.width - gap - primaryWidth;

  if (
    primaryWidth < constraints.minWidth ||
    secondaryWidth < constraints.minWidth
  ) {
    return null;
  }

  const secondaryCount = itemCount - 1;
  const verticalGap =
    WORKBENCH_LAYOUT_PRESET_GAP_PX * Math.max(0, secondaryCount - 1);
  const secondaryHeight = Math.floor(
    (frame.height - verticalGap) / secondaryCount
  );

  if (secondaryHeight < constraints.minHeight) {
    return null;
  }

  const frames: WorkbenchFrame[] = [
    {
      x: frame.x,
      y: frame.y,
      width: primaryWidth,
      height: frame.height
    }
  ];

  const secondaryX = frame.x + primaryWidth + gap;
  for (let index = 0; index < secondaryCount; index += 1) {
    frames.push({
      x: secondaryX,
      y: frame.y + index * (secondaryHeight + WORKBENCH_LAYOUT_PRESET_GAP_PX),
      width: secondaryWidth,
      height: secondaryHeight
    });
  }

  return frames;
}

function getBestBalancedGridLayoutFrames(
  itemCount: number,
  frame: WorkbenchFrame,
  constraints: WorkbenchLayoutConstraints
): WorkbenchFrame[] | null {
  let best: {
    columns: number;
    emptySlots: number;
    frames: WorkbenchFrame[];
    shapeDistance: number;
  } | null = null;

  for (let columns = 2; columns <= itemCount; columns += 1) {
    const rows = Math.ceil(itemCount / columns);
    const frames = getGridLayoutFrames(itemCount, columns, frame, constraints);
    if (!frames) {
      continue;
    }

    const candidate = {
      columns,
      emptySlots: rows * columns - itemCount,
      frames,
      shapeDistance: Math.abs(columns - rows)
    };

    if (
      !best ||
      candidate.shapeDistance < best.shapeDistance ||
      (candidate.shapeDistance === best.shapeDistance &&
        candidate.emptySlots < best.emptySlots) ||
      (candidate.shapeDistance === best.shapeDistance &&
        candidate.emptySlots === best.emptySlots &&
        candidate.columns < best.columns)
    ) {
      best = candidate;
    }
  }

  return best?.frames ?? null;
}

function getSingleColumnLayoutFrames(
  itemCount: number,
  frame: WorkbenchFrame,
  constraints: WorkbenchLayoutConstraints
): WorkbenchFrame[] | null {
  const verticalGap =
    WORKBENCH_LAYOUT_PRESET_GAP_PX * Math.max(0, itemCount - 1);
  const cellHeight = Math.floor((frame.height - verticalGap) / itemCount);

  if (cellHeight < constraints.minHeight) {
    return null;
  }

  const frames: WorkbenchFrame[] = [];
  for (let index = 0; index < itemCount; index += 1) {
    frames.push({
      x: frame.x,
      y: frame.y + index * (cellHeight + WORKBENCH_LAYOUT_PRESET_GAP_PX),
      width: frame.width,
      height: cellHeight
    });
  }

  return frames;
}
