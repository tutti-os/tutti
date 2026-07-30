import {
  distanceFromBottomForAgentTranscriptTurn,
  type AgentTranscriptVirtualLayout
} from "./agentTranscriptVirtualizerLayout";

export function agentTranscriptPhysicalDistanceForOffset(input: {
  layout: AgentTranscriptVirtualLayout;
  offset: number;
  responseSpacerHeightPx: number;
  scrollMarginPx: number;
  scrollPaddingBottomPx: number;
  viewportHeightPx: number;
}): number {
  const maxScrollTop = Math.max(
    0,
    input.scrollMarginPx +
      input.layout.totalHeightPx -
      input.viewportHeightPx +
      input.scrollPaddingBottomPx +
      input.responseSpacerHeightPx
  );
  return Math.max(0, maxScrollTop - Math.max(0, input.offset));
}

export function agentTranscriptPhysicalDistanceForIndex(input: {
  align: "center" | "top";
  layout: AgentTranscriptVirtualLayout;
  responseSpacerHeightPx: number;
  turnIndex: number;
  viewportHeightPx: number;
}): number | null {
  const turnKey = input.layout.turnKeys[input.turnIndex];
  if (!turnKey) return null;
  const distanceFromBottom = distanceFromBottomForAgentTranscriptTurn({
    align: input.align,
    layout: input.layout,
    turnKey,
    viewportHeightPx: input.viewportHeightPx
  });
  return distanceFromBottom === null
    ? null
    : distanceFromBottom + input.responseSpacerHeightPx;
}
