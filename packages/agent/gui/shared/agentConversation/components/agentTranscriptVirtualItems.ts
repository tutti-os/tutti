import type { AgentTranscriptVirtualLayout } from "./agentTranscriptVirtualizerLayout";
import type { AgentTranscriptVirtualItem } from "./agentTranscriptVirtualizerTypes";

export function buildAgentTranscriptVirtualItems(input: {
  layout: AgentTranscriptVirtualLayout;
  measuredHeightsByKey: Readonly<Record<string, number>>;
  range: { endIndex: number; startIndex: number };
}): readonly AgentTranscriptVirtualItem[] {
  return input.layout.turnKeys
    .slice(input.range.startIndex, input.range.endIndex)
    .map((key, relativeIndex) => {
      const index = input.range.startIndex + relativeIndex;
      return {
        index,
        key,
        measured: input.measuredHeightsByKey[key] !== undefined,
        size: input.layout.heightsPx[index] ?? 0,
        start: input.layout.topOffsetsPx[index] ?? 0
      };
    });
}
