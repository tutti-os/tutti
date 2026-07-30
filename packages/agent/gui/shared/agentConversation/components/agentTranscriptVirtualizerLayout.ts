export const AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX = 280;
export const AGENT_TRANSCRIPT_INITIAL_VIEWPORT_HEIGHT_PX = 800;
export const AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN = 2;
export const AGENT_TRANSCRIPT_RESPONSE_SPACER_MIN_CONTENT_HEIGHT_PX = 240;
export const AGENT_TRANSCRIPT_RESPONSE_SPACER_VIEWPORT_RATIO = 2 / 3;

export interface AgentTranscriptVirtualLayoutEntry {
  gapAfterPx: number;
  key: string;
}

export interface AgentTranscriptVirtualRange {
  endIndex: number;
  startIndex: number;
}

export interface AgentTranscriptVirtualLayout {
  bottomOffsetsPx: readonly number[];
  gapsAfterPx: readonly number[];
  heightsPx: readonly number[];
  topOffsetsPx: readonly number[];
  totalHeightPx: number;
  turnIndexByKey: ReadonlyMap<string, number>;
  turnKeys: readonly string[];
}

export interface AgentTranscriptVirtualViewportState {
  distanceFromBottomPx: number;
  renderedRange: AgentTranscriptVirtualRange;
  turnKeys: readonly string[];
  viewportHeightPx: number;
}

export function agentTranscriptVirtualViewportRenderStateChanged(
  previous: AgentTranscriptVirtualViewportState,
  next: AgentTranscriptVirtualViewportState
): boolean {
  return (
    previous.viewportHeightPx !== next.viewportHeightPx ||
    previous.renderedRange.startIndex !== next.renderedRange.startIndex ||
    previous.renderedRange.endIndex !== next.renderedRange.endIndex ||
    (previous.turnKeys !== next.turnKeys &&
      (previous.turnKeys.length !== next.turnKeys.length ||
        previous.turnKeys.some((key, index) => key !== next.turnKeys[index])))
  );
}

export function agentTranscriptResponseSpacerHeight(input: {
  bottomInsetPx: number;
  viewportHeightPx: number;
}): number {
  const availableHeightPx = Math.max(
    0,
    input.viewportHeightPx - Math.max(0, input.bottomInsetPx)
  );
  return Math.max(
    0,
    Math.min(
      availableHeightPx * AGENT_TRANSCRIPT_RESPONSE_SPACER_VIEWPORT_RATIO,
      availableHeightPx - AGENT_TRANSCRIPT_RESPONSE_SPACER_MIN_CONTENT_HEIGHT_PX
    )
  );
}

export function buildAgentTranscriptVirtualLayout(
  entries: readonly AgentTranscriptVirtualLayoutEntry[],
  measuredHeightsByKey: Readonly<Record<string, number>>
): AgentTranscriptVirtualLayout {
  const heightsPx: number[] = [];
  const gapsAfterPx: number[] = [];
  const topOffsetsPx: number[] = [];
  const turnIndexByKey = new Map<string, number>();
  const turnKeys: string[] = [];
  let totalHeightPx = 0;

  entries.forEach((entry, index) => {
    const heightPx =
      measuredHeightsByKey[entry.key] ??
      AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX;
    const gapAfterPx = index < entries.length - 1 ? entry.gapAfterPx : 0;
    turnIndexByKey.set(entry.key, index);
    turnKeys.push(entry.key);
    topOffsetsPx.push(totalHeightPx);
    heightsPx.push(heightPx);
    gapsAfterPx.push(gapAfterPx);
    totalHeightPx += heightPx + gapAfterPx;
  });

  return {
    bottomOffsetsPx: topOffsetsPx.map(
      (topOffsetPx, index) =>
        totalHeightPx - topOffsetPx - (heightsPx[index] ?? 0)
    ),
    gapsAfterPx,
    heightsPx,
    topOffsetsPx,
    totalHeightPx,
    turnIndexByKey,
    turnKeys
  };
}

export function agentTranscriptVirtualLayoutsEqual(
  previous: AgentTranscriptVirtualLayout,
  next: AgentTranscriptVirtualLayout
): boolean {
  return (
    previous.totalHeightPx === next.totalHeightPx &&
    previous.turnKeys.length === next.turnKeys.length &&
    previous.turnKeys.every(
      (key, index) =>
        key === next.turnKeys[index] &&
        previous.heightsPx[index] === next.heightsPx[index] &&
        previous.gapsAfterPx[index] === next.gapsAfterPx[index]
    )
  );
}

export function findAgentTranscriptVirtualRange(input: {
  distanceFromBottomPx: number;
  layout: AgentTranscriptVirtualLayout;
  overscanCount?: number;
  viewportHeightPx: number;
}): AgentTranscriptVirtualRange {
  const {
    distanceFromBottomPx,
    layout,
    overscanCount = AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN,
    viewportHeightPx
  } = input;
  if (layout.turnKeys.length === 0) {
    return { endIndex: 0, startIndex: 0 };
  }

  const viewportBottomFromBottomPx = Math.min(
    Math.max(0, distanceFromBottomPx),
    layout.totalHeightPx
  );
  const viewportTopFromBottomPx = Math.min(
    viewportBottomFromBottomPx + Math.max(0, viewportHeightPx),
    layout.totalHeightPx
  );
  const firstVisibleIndex = findFirstBottomOffsetBelow(
    layout.bottomOffsetsPx,
    viewportTopFromBottomPx
  );
  const lastVisibleIndex = findFirstTurnEndingAbove(
    layout.bottomOffsetsPx,
    layout.heightsPx,
    viewportBottomFromBottomPx
  );

  return {
    startIndex: Math.max(0, firstVisibleIndex - overscanCount),
    endIndex: Math.min(
      layout.turnKeys.length,
      Math.max(lastVisibleIndex, firstVisibleIndex + 1) + overscanCount
    )
  };
}

export function preserveAgentTranscriptVirtualRangeAnchor(input: {
  anchorKey: string;
  layout: AgentTranscriptVirtualLayout;
  previousRange: AgentTranscriptVirtualRange;
}): AgentTranscriptVirtualRange | null {
  const anchorIndex = input.layout.turnIndexByKey.get(input.anchorKey);
  if (anchorIndex === undefined) {
    return null;
  }
  return {
    startIndex: anchorIndex,
    endIndex: Math.min(
      input.layout.turnKeys.length,
      anchorIndex +
        input.previousRange.endIndex -
        input.previousRange.startIndex
    )
  };
}

export function projectAgentTranscriptVirtualRange(input: {
  current: AgentTranscriptVirtualViewportState;
  layout: AgentTranscriptVirtualLayout;
  locatingTurnKey?: string | null;
}): AgentTranscriptVirtualRange {
  if (input.locatingTurnKey) {
    const distanceFromBottomPx = distanceFromBottomForAgentTranscriptTurn({
      align: "center",
      layout: input.layout,
      turnKey: input.locatingTurnKey,
      viewportHeightPx: input.current.viewportHeightPx
    });
    if (distanceFromBottomPx !== null) {
      return findAgentTranscriptVirtualRange({
        distanceFromBottomPx,
        layout: input.layout,
        viewportHeightPx: input.current.viewportHeightPx
      });
    }
  }
  const turnKeysEqual =
    input.current.turnKeys === input.layout.turnKeys ||
    (input.current.turnKeys.length === input.layout.turnKeys.length &&
      input.current.turnKeys.every(
        (key, index) => key === input.layout.turnKeys[index]
      ));
  if (turnKeysEqual) {
    return input.current.renderedRange;
  }
  const anchorKey =
    input.current.turnKeys[input.current.renderedRange.startIndex];
  return anchorKey
    ? (preserveAgentTranscriptVirtualRangeAnchor({
        anchorKey,
        layout: input.layout,
        previousRange: input.current.renderedRange
      }) ?? input.current.renderedRange)
    : input.current.renderedRange;
}

export function compensateAgentTranscriptDistanceForAnchor(input: {
  anchorKey: string;
  distanceFromBottomPx: number;
  nextLayout: AgentTranscriptVirtualLayout;
  previousLayout: AgentTranscriptVirtualLayout;
}): number | null {
  const previousIndex = input.previousLayout.turnIndexByKey.get(
    input.anchorKey
  );
  const nextIndex = input.nextLayout.turnIndexByKey.get(input.anchorKey);
  if (previousIndex === undefined || nextIndex === undefined) {
    return null;
  }
  const previousAnchorTopFromBottomPx =
    (input.previousLayout.bottomOffsetsPx[previousIndex] ?? 0) +
    (input.previousLayout.heightsPx[previousIndex] ?? 0);
  const nextAnchorTopFromBottomPx =
    (input.nextLayout.bottomOffsetsPx[nextIndex] ?? 0) +
    (input.nextLayout.heightsPx[nextIndex] ?? 0);
  return Math.max(
    0,
    input.distanceFromBottomPx +
      nextAnchorTopFromBottomPx -
      previousAnchorTopFromBottomPx
  );
}

export function findAgentTranscriptCompensationAnchor(input: {
  distanceFromBottomPx: number;
  fallbackRange: AgentTranscriptVirtualRange;
  layout: AgentTranscriptVirtualLayout;
  measuredHeightsByKey: Readonly<Record<string, number>>;
  viewportHeightPx: number;
}): string | null {
  const visibleRange = findAgentTranscriptVirtualRange({
    distanceFromBottomPx: input.distanceFromBottomPx,
    layout: input.layout,
    overscanCount: 0,
    viewportHeightPx: input.viewportHeightPx
  });
  for (
    let index = visibleRange.startIndex;
    index < visibleRange.endIndex;
    index += 1
  ) {
    const key = input.layout.turnKeys[index];
    if (key && input.measuredHeightsByKey[key] !== undefined) {
      return key;
    }
  }
  return input.layout.turnKeys[input.fallbackRange.startIndex] ?? null;
}

export function distanceFromBottomForAgentTranscriptTurn(input: {
  align: "center" | "top";
  layout: AgentTranscriptVirtualLayout;
  turnKey: string;
  viewportHeightPx: number;
}): number | null {
  const turnIndex = input.layout.turnIndexByKey.get(input.turnKey);
  if (turnIndex === undefined) {
    return null;
  }
  const bottomOffsetPx = input.layout.bottomOffsetsPx[turnIndex] ?? 0;
  const heightPx = input.layout.heightsPx[turnIndex] ?? 0;
  return input.align === "center"
    ? Math.max(0, bottomOffsetPx - input.viewportHeightPx / 2 + heightPx / 2)
    : Math.max(0, bottomOffsetPx + heightPx - 10);
}

export function findAgentTranscriptTurnIndexAtOffset(
  layout: AgentTranscriptVirtualLayout,
  offsetFromListTopPx: number
): number | null {
  if (layout.turnKeys.length === 0) {
    return null;
  }
  const offsetPx = Math.max(
    0,
    Math.min(offsetFromListTopPx, layout.totalHeightPx)
  );
  let start = 0;
  let end = layout.topOffsetsPx.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if ((layout.topOffsetsPx[middle] ?? 0) <= offsetPx) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  return Math.min(layout.turnKeys.length - 1, Math.max(0, start - 1));
}

export function rangeContainsAgentTranscriptRange(
  current: AgentTranscriptVirtualRange,
  next: AgentTranscriptVirtualRange
): boolean {
  return (
    current.startIndex <= next.startIndex && current.endIndex >= next.endIndex
  );
}

export function updateAgentTranscriptVirtualViewportState(input: {
  current: AgentTranscriptVirtualViewportState;
  distanceFromBottomPx: number;
  layout: AgentTranscriptVirtualLayout;
  viewportHeightPx: number;
}): AgentTranscriptVirtualViewportState {
  const distanceFromBottomPx = Math.min(
    Math.max(0, input.distanceFromBottomPx),
    input.layout.totalHeightPx
  );
  const nextRange = findAgentTranscriptVirtualRange({
    distanceFromBottomPx,
    layout: input.layout,
    viewportHeightPx: input.viewportHeightPx
  });
  const renderedRange = rangeContainsAgentTranscriptRange(
    input.current.renderedRange,
    nextRange
  )
    ? input.current.renderedRange
    : nextRange;
  const turnKeysEqual =
    input.current.turnKeys === input.layout.turnKeys ||
    (input.current.turnKeys.length === input.layout.turnKeys.length &&
      input.current.turnKeys.every(
        (key, index) => key === input.layout.turnKeys[index]
      ));
  if (
    input.current.distanceFromBottomPx === distanceFromBottomPx &&
    input.current.viewportHeightPx === input.viewportHeightPx &&
    input.current.renderedRange === renderedRange &&
    turnKeysEqual
  ) {
    return input.current;
  }
  return {
    distanceFromBottomPx,
    renderedRange,
    turnKeys: input.layout.turnKeys,
    viewportHeightPx: input.viewportHeightPx
  };
}

function findFirstBottomOffsetBelow(
  bottomOffsetsPx: readonly number[],
  targetPx: number
): number {
  let start = 0;
  let end = bottomOffsetsPx.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if ((bottomOffsetsPx[middle] ?? 0) < targetPx) {
      end = middle;
    } else {
      start = middle + 1;
    }
  }
  return start;
}

function findFirstTurnEndingAbove(
  bottomOffsetsPx: readonly number[],
  heightsPx: readonly number[],
  targetPx: number
): number {
  let start = 0;
  let end = bottomOffsetsPx.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if ((bottomOffsetsPx[middle] ?? 0) + (heightsPx[middle] ?? 0) <= targetPx) {
      end = middle;
    } else {
      start = middle + 1;
    }
  }
  return start;
}
