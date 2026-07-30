import {
  agentTranscriptVirtualLayoutsEqual,
  buildAgentTranscriptVirtualLayout,
  type AgentTranscriptVirtualLayout,
  type AgentTranscriptVirtualLayoutEntry
} from "./agentTranscriptVirtualizerLayout";

export interface AgentTranscriptPreparedMeasurement {
  latestTurnHeightDeltaPx: number;
  layout: AgentTranscriptVirtualLayout;
  logicalDistanceFromBottomPx: number;
  physicalScrollDistanceFromBottomPx: number | null;
}

export function prepareAgentTranscriptMeasurement(input: {
  currentLogicalDistanceFromBottomPx: number;
  currentPhysicalDistanceFromBottomPx: number;
  entries: readonly AgentTranscriptVirtualLayoutEntry[];
  measuredHeightsByKey: Readonly<Record<string, number>>;
  nextHeightsByKey: Readonly<Record<string, number>>;
  preserveMeasuredTurnViewport: boolean;
  previousLayout: AgentTranscriptVirtualLayout;
  responseSpacerHeightPx: number;
}): AgentTranscriptPreparedMeasurement | null {
  const nextLayout = buildAgentTranscriptVirtualLayout(
    input.entries,
    input.nextHeightsByKey
  );
  if (agentTranscriptVirtualLayoutsEqual(input.previousLayout, nextLayout)) {
    return null;
  }

  let compensationPx = 0;
  let latestTurnHeightDeltaPx = 0;
  for (const [key, nextMeasuredHeightPx] of Object.entries(
    input.nextHeightsByKey
  )) {
    const index = input.previousLayout.turnIndexByKey.get(key);
    if (index === undefined) continue;
    const previousMeasuredHeightPx = input.measuredHeightsByKey[key];
    if (previousMeasuredHeightPx === nextMeasuredHeightPx) continue;
    const isLatestTurn = index === input.previousLayout.turnKeys.length - 1;
    if (isLatestTurn && previousMeasuredHeightPx !== undefined) {
      latestTurnHeightDeltaPx +=
        nextMeasuredHeightPx - previousMeasuredHeightPx;
    }
    const layoutHeightDeltaPx =
      nextMeasuredHeightPx -
      (input.previousLayout.heightsPx[index] ?? nextMeasuredHeightPx);
    const bottomOffsetPx = input.previousLayout.bottomOffsetsPx[index] ?? 0;
    if (
      layoutHeightDeltaPx !== 0 &&
      bottomOffsetPx <= input.currentLogicalDistanceFromBottomPx &&
      input.preserveMeasuredTurnViewport
    ) {
      compensationPx += layoutHeightDeltaPx;
    }
  }

  const pinnedToPhysicalBottom =
    input.preserveMeasuredTurnViewport &&
    input.currentPhysicalDistanceFromBottomPx <=
      (input.responseSpacerHeightPx > 0 ? 0 : 24);
  const physicalScrollDistanceFromBottomPx = pinnedToPhysicalBottom
    ? 0
    : compensationPx === 0
      ? null
      : input.currentPhysicalDistanceFromBottomPx + compensationPx;
  const logicalDistanceFromBottomPx =
    physicalScrollDistanceFromBottomPx === null
      ? input.currentLogicalDistanceFromBottomPx
      : Math.max(
          0,
          physicalScrollDistanceFromBottomPx - input.responseSpacerHeightPx
        );

  return {
    latestTurnHeightDeltaPx,
    layout: nextLayout,
    logicalDistanceFromBottomPx,
    physicalScrollDistanceFromBottomPx
  };
}
