import {
  useCallback,
  useImperativeHandle,
  useRef,
  type Ref,
  type RefObject
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AgentConversationFollowEndMode } from "../agentConversationFollowEndController";
import type { AgentTranscriptTurnGroup } from "./agentTranscriptModel";

const AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN = 6;
export const AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX = 280;
const preventVirtualScrollAdjustment = () => false;

export interface AgentTranscriptVirtualScrollController {
  agentSessionId: string;
  enabled: boolean;
  isAtEnd(threshold?: number): boolean;
  scrollToEnd(options?: { behavior?: ScrollBehavior }): void;
}

interface AgentTranscriptVirtualizer {
  setVirtualizerHostElement(node: HTMLDivElement | null): void;
  rowVirtualizer: ReturnType<typeof useVirtualizer<HTMLElement, Element>>;
  virtualizerHostRef: RefObject<HTMLDivElement | null>;
}

export function useAgentTranscriptVirtualizer({
  agentSessionId,
  followEndMode = "following",
  hasMovingTurnDisclosure,
  scrollElement,
  scrollMargin,
  shouldVirtualize,
  turnGroups,
  virtualScrollControllerRef
}: {
  agentSessionId: string;
  followEndMode?: AgentConversationFollowEndMode;
  hasMovingTurnDisclosure: boolean;
  scrollElement: HTMLElement | null;
  scrollMargin: number;
  shouldVirtualize: boolean;
  turnGroups: readonly AgentTranscriptTurnGroup[];
  virtualScrollControllerRef?: Ref<AgentTranscriptVirtualScrollController>;
}): AgentTranscriptVirtualizer {
  const virtualizerHostRef = useRef<HTMLDivElement | null>(null);
  const followsEnd = followEndMode === "following";
  const getVirtualItemKey = useCallback(
    (index: number) =>
      `${agentSessionId}\u0000${turnGroups[index]?.key ?? index}`,
    [agentSessionId, turnGroups]
  );
  const rowVirtualizer = useVirtualizer<HTMLElement, Element>({
    anchorTo: shouldVirtualize && hasMovingTurnDisclosure ? "start" : "end",
    count: turnGroups.length,
    directDomUpdates: true,
    directDomUpdatesMode: "transform",
    estimateSize: () => AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX,
    followOnAppend: shouldVirtualize && followsEnd && !hasMovingTurnDisclosure,
    getItemKey: getVirtualItemKey,
    getScrollElement: () => scrollElement,
    overscan: AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN,
    scrollMargin,
    scrollEndThreshold: 24,
    useFlushSync: true
  });
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    shouldVirtualize && hasMovingTurnDisclosure
      ? preventVirtualScrollAdjustment
      : undefined;
  useImperativeHandle(
    virtualScrollControllerRef,
    () => ({
      agentSessionId,
      enabled: shouldVirtualize,
      isAtEnd: (threshold) =>
        shouldVirtualize && rowVirtualizer.isAtEnd(threshold),
      scrollToEnd: (options) => {
        if (shouldVirtualize) {
          rowVirtualizer.scrollToEnd(options);
        }
      }
    }),
    [agentSessionId, rowVirtualizer, shouldVirtualize]
  );
  const setVirtualizerHostElement = useCallback(
    (node: HTMLDivElement | null) => {
      virtualizerHostRef.current = node;
      rowVirtualizer.containerRef(node);
    },
    [rowVirtualizer]
  );

  return {
    setVirtualizerHostElement,
    rowVirtualizer,
    virtualizerHostRef
  };
}
