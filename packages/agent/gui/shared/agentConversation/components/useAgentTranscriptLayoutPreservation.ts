import { useCallback, useRef, type RefObject } from "react";
import {
  cancelUiAnimationFrame,
  requestUiAnimationFrame
} from "./agentTranscriptPresentationScheduler";
import {
  agentTranscriptNativeScrollTopForDistance,
  hasActiveAgentTranscriptScroll,
  setAgentTranscriptScrollTop
} from "./agentTranscriptScrollController";

interface PendingLayoutPreservation {
  distanceFromBottomPx: number;
  scrollHeightPx: number;
  wheelDistanceFromBottomPx: number;
}

export function useAgentTranscriptLayoutPreservation(input: {
  getDistanceFromBottomPx(): number;
  scrollElementRef: RefObject<HTMLElement | null>;
  scrollPaddingBottomRef: RefObject<number>;
}) {
  const { getDistanceFromBottomPx, scrollElementRef, scrollPaddingBottomRef } =
    input;
  const pendingRef = useRef<PendingLayoutPreservation | null>(null);
  const clearFrameRef = useRef<number | null>(null);

  const clear = useCallback((): void => {
    pendingRef.current = null;
    if (clearFrameRef.current !== null) {
      cancelUiAnimationFrame(clearFrameRef.current);
      clearFrameRef.current = null;
    }
  }, []);

  const preserveForNextLayout = useCallback((): void => {
    const element = scrollElementRef.current;
    if (!element || pendingRef.current) return;
    const preservation: PendingLayoutPreservation = {
      distanceFromBottomPx: getDistanceFromBottomPx(),
      scrollHeightPx: element.scrollHeight,
      wheelDistanceFromBottomPx: 0
    };
    pendingRef.current = preservation;
    clearFrameRef.current = requestUiAnimationFrame(() => {
      if (pendingRef.current === preservation) pendingRef.current = null;
      clearFrameRef.current = null;
    });
  }, [getDistanceFromBottomPx, scrollElementRef]);

  const addWheelDelta = useCallback((deltaPx: number): void => {
    const preservation = pendingRef.current;
    if (preservation) {
      preservation.wheelDistanceFromBottomPx -= deltaPx;
    }
  }, []);

  const consumeDistance = useCallback((): number | null => {
    const preservation = pendingRef.current;
    if (!preservation) return null;
    const distance = Math.max(
      0,
      preservation.distanceFromBottomPx + preservation.wheelDistanceFromBottomPx
    );
    clear();
    return distance;
  }, [clear]);

  const restoreAfterScrollHeightChange = useCallback((): number | null => {
    const element = scrollElementRef.current;
    const preservation = pendingRef.current;
    if (!element || !preservation) return null;
    if (element.scrollHeight === preservation.scrollHeightPx) return null;
    if (hasActiveAgentTranscriptScroll(element)) {
      clear();
      return null;
    }
    const distance = consumeDistance();
    if (distance === null) return null;
    setAgentTranscriptScrollTop(
      element,
      agentTranscriptNativeScrollTopForDistance(
        distance,
        scrollPaddingBottomRef.current
      )
    );
    return distance;
  }, [consumeDistance, scrollElementRef, scrollPaddingBottomRef]);

  return {
    addWheelDelta,
    cancel: clear,
    consumeDistance,
    preserveForNextLayout,
    restoreAfterScrollHeightChange
  };
}
