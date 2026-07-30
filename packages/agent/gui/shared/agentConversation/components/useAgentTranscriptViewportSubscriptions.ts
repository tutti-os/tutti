import { useCallback, useRef, type MutableRefObject } from "react";
import type { AgentTranscriptUserScrollDirection } from "./agentTranscriptScrollController";
import type { AgentTranscriptViewportSnapshot } from "./agentTranscriptVirtualizerTypes";
import type {
  AgentTranscriptVirtualLayout,
  AgentTranscriptVirtualViewportState
} from "./agentTranscriptVirtualizerLayout";

interface AgentTranscriptViewportSubscriptionsInput {
  layoutRef: MutableRefObject<AgentTranscriptVirtualLayout>;
  physicalDistanceFromBottomRef: MutableRefObject<number>;
  responseSpacerHeightRef: MutableRefObject<number>;
  scrollMarginRef: MutableRefObject<number>;
  scrollPaddingBottomRef: MutableRefObject<number>;
  scrollPaddingTopRef: MutableRefObject<number>;
  scrollTopRef: MutableRefObject<number>;
  virtualViewportRef: MutableRefObject<AgentTranscriptVirtualViewportState>;
}

export function useAgentTranscriptViewportSubscriptions({
  layoutRef,
  physicalDistanceFromBottomRef,
  responseSpacerHeightRef,
  scrollMarginRef,
  scrollPaddingBottomRef,
  scrollPaddingTopRef,
  scrollTopRef,
  virtualViewportRef
}: AgentTranscriptViewportSubscriptionsInput) {
  const viewportListenersRef = useRef(
    new Set<(snapshot: AgentTranscriptViewportSnapshot) => void>()
  );
  const userScrollListenersRef = useRef(
    new Set<(direction: AgentTranscriptUserScrollDirection) => void>()
  );
  const readViewportSnapshot = useCallback(
    (): AgentTranscriptViewportSnapshot => ({
      contentHeightPx:
        scrollMarginRef.current +
        layoutRef.current.totalHeightPx +
        scrollPaddingBottomRef.current +
        responseSpacerHeightRef.current,
      contentDistanceFromBottomPx: Math.max(
        0,
        physicalDistanceFromBottomRef.current - responseSpacerHeightRef.current
      ),
      distanceFromBottomPx: physicalDistanceFromBottomRef.current,
      scrollPaddingBottomPx: scrollPaddingBottomRef.current,
      scrollPaddingTopPx: scrollPaddingTopRef.current,
      scrollTopPx: scrollTopRef.current,
      viewportHeightPx: virtualViewportRef.current.viewportHeightPx
    }),
    []
  );
  const subscribeViewport = useCallback(
    (listener: (snapshot: AgentTranscriptViewportSnapshot) => void) => {
      viewportListenersRef.current.add(listener);
      listener(readViewportSnapshot());
      return () => viewportListenersRef.current.delete(listener);
    },
    [readViewportSnapshot]
  );
  const subscribeUserScroll = useCallback(
    (listener: (direction: AgentTranscriptUserScrollDirection) => void) => {
      userScrollListenersRef.current.add(listener);
      return () => userScrollListenersRef.current.delete(listener);
    },
    []
  );
  const notifyViewportListeners = useCallback((): void => {
    const snapshot = readViewportSnapshot();
    viewportListenersRef.current.forEach((listener) => listener(snapshot));
  }, [readViewportSnapshot]);
  const notifyUserScrollListeners = useCallback(
    (direction: AgentTranscriptUserScrollDirection): void => {
      userScrollListenersRef.current.forEach((listener) => listener(direction));
    },
    []
  );
  return {
    notifyUserScrollListeners,
    notifyViewportListeners,
    readViewportSnapshot,
    subscribeUserScroll,
    subscribeViewport
  };
}
