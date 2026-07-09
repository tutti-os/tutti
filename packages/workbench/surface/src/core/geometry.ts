import {
  defaultWorkbenchLayoutConstraints,
  type WorkbenchFrame,
  type WorkbenchLayoutPreset,
  type WorkbenchLayoutConstraints,
  type WorkbenchLayoutConstraintsInput,
  type WorkbenchLockedLayout,
  type WorkbenchNodeSizeConstraints,
  type WorkbenchQuickLayoutTarget,
  type WorkbenchSafeArea,
  type WorkbenchSize,
  type WorkbenchSnapTarget
} from "./types.ts";

export const WORKBENCH_MIN_VISIBLE_PX = 40;
export const WORKBENCH_LAYOUT_PRESET_GAP_PX = 12;
export const WORKBENCH_EDGE_SNAP_THRESHOLD_PX = 24;

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
  const halfWidth = Math.round(full.width / 2);
  const halfHeight = Math.round(full.height / 2);
  const clampSnapRect = (rect: WorkbenchFrame): WorkbenchFrame =>
    clampWorkbenchRect(rect, surfaceSize, normalized);

  switch (snapTarget) {
    case "left":
      return clampSnapRect({ ...full, width: halfWidth });
    case "right":
      return clampSnapRect({
        ...full,
        x: full.x + full.width - halfWidth,
        width: halfWidth
      });
    case "top":
      return clampSnapRect(full);
    case "bottom":
      return clampSnapRect({
        ...full,
        y: full.y + full.height - halfHeight,
        height: halfHeight
      });
    case "top-left":
      return clampSnapRect({ ...full, width: halfWidth, height: halfHeight });
    case "top-right":
      return clampSnapRect({
        ...full,
        x: full.x + full.width - halfWidth,
        width: halfWidth,
        height: halfHeight
      });
    case "bottom-left":
      return clampSnapRect({
        ...full,
        y: full.y + full.height - halfHeight,
        width: halfWidth,
        height: halfHeight
      });
    case "bottom-right":
      return clampSnapRect({
        ...full,
        x: full.x + full.width - halfWidth,
        y: full.y + full.height - halfHeight,
        width: halfWidth,
        height: halfHeight
      });
    case null:
      return null;
  }
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
  const halfWidth = Math.round(full.width / 2);
  const halfHeight = Math.round(full.height / 2);
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
      return clampQuickLayoutRect({
        ...full,
        y: full.y + full.height - halfHeight,
        height: halfHeight
      });
    }
    case "center": {
      const width = Math.round(full.width * 0.72);
      const height = Math.round(full.height * 0.72);
      return clampQuickLayoutRect({
        x: full.x + Math.round((full.width - width) / 2),
        y: full.y + Math.round((full.height - height) / 2),
        width,
        height
      });
    }
    case "top-left":
      return clampQuickLayoutRect({
        ...full,
        width: halfWidth,
        height: halfHeight
      });
    case "top-right":
      return clampQuickLayoutRect({
        ...full,
        x: full.x + full.width - halfWidth,
        width: halfWidth,
        height: halfHeight
      });
    case "bottom-left":
      return clampQuickLayoutRect({
        ...full,
        y: full.y + full.height - halfHeight,
        width: halfWidth,
        height: halfHeight
      });
    case "bottom-right":
      return clampQuickLayoutRect({
        ...full,
        x: full.x + full.width - halfWidth,
        y: full.y + full.height - halfHeight,
        width: halfWidth,
        height: halfHeight
      });
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

export function normalizeWorkbenchFrameToRect(
  frame: WorkbenchFrame,
  rect: WorkbenchFrame
): WorkbenchFrame {
  const width = Math.max(rect.width, 1);
  const height = Math.max(rect.height, 1);
  return {
    x: (frame.x - rect.x) / width,
    y: (frame.y - rect.y) / height,
    width: frame.width / width,
    height: frame.height / height
  };
}

export function denormalizeWorkbenchFrameFromRect(
  normalized: WorkbenchFrame,
  rect: WorkbenchFrame
): WorkbenchFrame {
  return {
    x: rect.x + normalized.x * rect.width,
    y: rect.y + normalized.y * rect.height,
    width: normalized.width * rect.width,
    height: normalized.height * rect.height
  };
}

/**
 * Resolves the slot frames of a locked layout at the given surface size: the
 * user-adjusted grid geometry when present, the preset frames otherwise.
 * Returns null when no lock is active or the preset cannot be laid out.
 */
export function getWorkbenchLockedSlotFrames(
  lockedLayout: WorkbenchLockedLayout | null,
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints
): Array<{ nodeID: string; frame: WorkbenchFrame }> | null {
  if (!lockedLayout || lockedLayout.nodeIDs.length < 2) {
    return null;
  }
  const normalizedFrames = lockedLayout.normalizedFrames;
  if (normalizedFrames) {
    const rect = getWorkbenchSafeLayoutRect(surfaceSize, constraints);
    const slots: Array<{ nodeID: string; frame: WorkbenchFrame }> = [];
    for (const nodeID of lockedLayout.nodeIDs) {
      const normalized = normalizedFrames[nodeID];
      if (normalized) {
        slots.push({
          nodeID,
          frame: denormalizeWorkbenchFrameFromRect(normalized, rect)
        });
      }
    }
    return slots.length >= 2 ? slots : null;
  }
  const frames = getWorkbenchLayoutPresetFrames(
    lockedLayout.nodeIDs.length,
    lockedLayout.preset,
    surfaceSize,
    constraints
  );
  if (!frames) {
    return null;
  }
  return lockedLayout.nodeIDs.map((nodeID, index) => ({
    nodeID,
    frame: frames[index]!
  }));
}

export function getWorkbenchSafeLayoutRect(
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
  dragPoint: Pick<WorkbenchFrame, "x" | "y">,
  surfaceSize: WorkbenchSize,
  threshold = 0,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints
): WorkbenchSnapTarget {
  const frame = getWorkbenchLayoutFrame(surfaceSize, constraints);
  const crossesLeft =
    threshold > 0
      ? dragPoint.x <= frame.x + threshold
      : dragPoint.x < frame.x || (frame.x === 0 && dragPoint.x <= 0);
  const crossesRight =
    threshold > 0
      ? dragPoint.x >= frame.x + frame.width - threshold
      : dragPoint.x > frame.x + frame.width ||
        (frame.x + frame.width === surfaceSize.width &&
          dragPoint.x >= surfaceSize.width);
  const crossesTop =
    threshold > 0
      ? dragPoint.y <= frame.y + threshold
      : dragPoint.y < frame.y || (frame.y === 0 && dragPoint.y <= 0);
  const crossesBottom =
    threshold > 0
      ? dragPoint.y >= frame.y + frame.height - threshold
      : dragPoint.y > frame.y + frame.height ||
        (frame.y + frame.height === surfaceSize.height &&
          dragPoint.y >= surfaceSize.height);

  if (crossesTop && crossesLeft) {
    return "top-left";
  }
  if (crossesTop && crossesRight) {
    return "top-right";
  }
  if (crossesBottom && crossesLeft) {
    return "bottom-left";
  }
  if (crossesBottom && crossesRight) {
    return "bottom-right";
  }
  if (crossesTop) {
    return "top";
  }
  if (crossesBottom) {
    return "bottom";
  }
  if (crossesLeft) {
    return "left";
  }
  if (crossesRight) {
    return "right";
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
